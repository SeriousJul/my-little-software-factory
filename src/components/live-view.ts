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
import { useMemo, useState } from "react";

import { isHeldCause, type TurnEndCause, type TurnLogEntry } from "../turn-log.ts";
import { useControlDispatch } from "./control-dispatch.ts";
import { type ControlContext, contextFor, type InteractionMode } from "./controls.ts";
import { decisionBodyLayout, turnLogBody } from "./decision-modal.ts";
import { maxScrollOf, windowOf } from "./geometry.ts";
import type { MdLine, MdSpan } from "./markdown.ts";
import type { MessageFact } from "./messages.ts";
import {
	type ActionRow,
	AGENT_VIEW_PANE,
	bodyRowSpans,
	decisionTitle,
	liveTitle,
	type ModalBody,
	ModalSurface,
	modalFrame,
	scrollbarRows,
	TURN_LOG_PANE,
	useModalPopScale,
} from "./modal-chrome.ts";
import { ActionItem } from "./shared/choices.ts";
import { turnEndCauseLine } from "./shared/presentation.ts";
import { useDecisionRegion } from "./shared/region.ts";
import { truncateToWidth, widthOf, wrapToWidth } from "./text.ts";
import { paint } from "./theme.ts";

/** The Live view leaves one cell of margin on every side. */
const MARGIN = 1;
/** The one row under the border that names the context. */
const CONTEXT_ROWS = 1;
/** The pane's border cells, top and bottom. */
const PANE_BORDERS = 2;
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
	context: ControlContext;
	/** False while a Key guide or Message view is above this view. */
	inputActive?: boolean;
	onHelp?: () => void;
	onMessage?: () => void;
	/** Reports the catalogue reason for a refused control on the Message line. */
	onUnavailable?: (reason: string) => void;
	/** The Message fact this view's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
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

export function LiveView({
	title,
	contextLine,
	blocked,
	body,
	cause = null,
	detail = "",
	actions,
	onAction,
	onEditAction,
	onGoto,
	onCancel,
	context,
	inputActive = true,
	onHelp,
	onMessage,
	onUnavailable,
	message,
	onEmergencyExit,
}: LiveViewProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	// The decision sub-mode, from the body the pane holds: a turn settling
	// for the operator flips it in place, without a second pop-in.
	const decideable = body.kind === "turn-log";
	const { pop, scale } = useModalPopScale();
	const frame = modalFrame(terminalWidth, terminalHeight, { margin: MARGIN, scale });
	// A held turn shows its cause in the region, above the rows it refuses
	// (ADR 0016): one row the body yields to, so the operator reads why the
	// turn is held before the rows that decide it.
	const held = decideable && cause !== null && isHeldCause(cause);
	const regionRows = decideable ? actions.length : 0;
	// The regions of the box: the pane's chrome, the body's rows, the
	// region's visible rows. The layout is decided at the final size, so
	// the scrollbar never flickers in and out while the pop-in grows the box.
	const finalLayout = decisionBodyLayout(
		modalFrame(terminalWidth, terminalHeight, { margin: MARGIN }).contentRows,
		regionRows,
		held,
	);
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
			body.kind === "turn-log"
				? turnLogBody(body.entries, paneInnerWidth)
				: streamLines(body.lines, body.note, paneInnerWidth),
		[body, paneInnerWidth],
	);
	const hasScrollbar = finalLayout !== null && fullWidthBody.length > finalLayout.paneRows;
	const bodyWidth = Math.max(1, paneInnerWidth - (hasScrollbar ? 1 : 0));
	// Wrap at the width the box has right now, so a line is never wider
	// than the frame being drawn while the pop-in grows the box.
	const renderedBody = useMemo(
		() =>
			body.kind === "turn-log"
				? turnLogBody(body.entries, bodyWidth)
				: streamLines(body.lines, body.note, bodyWidth),
		[body, bodyWidth],
	);
	const bodyRows = layout === null ? 0 : Math.min(renderedBody.length, layout.paneRows);
	const maxBodyScroll = maxScrollOf(renderedBody.length, bodyRows);
	// The newest output is in front: the body opens at its bottom and stays
	// pinned to it while new rows arrive, until the operator scrolls.
	const [bodyScroll, setBodyScroll] = useState<number | null>(null);
	// The region's selection, its wrap, its auto-scroll, its visible window,
	// and its range text are the shared region's, beside the field, the
	// selector row, and the form (ADR 0039 and ADR 0040).
	const region = useDecisionRegion(decideable ? actions : [], layout?.regionVisible ?? 0);
	const bodyEmpty =
		body.kind === "turn-log"
			? body.entries.length === 0
			: body.lines.length === 0 && body.note === null;
	const editableActionSelected =
		decideable && onEditAction !== undefined && actions[region.at]?.editable === true;
	// The sub-mode dispatches from the catalogue: the streaming sub-mode
	// answers to a live-view mode of its own, the settled sub-mode to the
	// decision-modal mode the glossary already names.
	const mode: InteractionMode = decideable ? "decision-modal" : "live-view";
	const surfaceContext = {
		...context,
		editableActionSelected,
		bodyScrollable: maxBodyScroll > 0,
		bodyEmpty,
		actionRowCount: regionRows,
	};

	// Scroll the body by one step of the named key: a page moves one viewport
	// minus the shared row, and the jump keys take either edge. A null view
	// is the bottom, so the first step reads the bottom's index. Reaching
	// the bottom re-pins the stream: new output comes into view again without
	// the operator asking.
	const scrollBody = (name: string) => {
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
		else setBodyScroll((current) => Math.max(0, (current ?? maxBodyScroll) - 1));
	};

	useControlDispatch({
		mode,
		context: contextFor(mode, surfaceContext),
		active: inputActive,
		onUnavailable,
		onEmergencyExit,
		handlers: {
			help: () => onHelp?.(),
			message: () => onMessage?.(),
			"cancel-action": onCancel,
			"scroll-body": ({ key }) => scrollBody(key.name),
			...(decideable
				? {
						"confirm-action": () => region.confirm((row) => onAction(row.key)),
						"select-action": ({ key }) => region.move(key.name === "up" ? -1 : 1),
						"edit-action": () => {
							const row = actions[region.at];
							if (row !== undefined && editableActionSelected) onEditAction?.(row.key);
						},
					}
				: { "live-goto": () => onGoto() }),
		},
	});

	const scroll = bodyScroll === null ? maxBodyScroll : Math.min(bodyScroll, maxBodyScroll);
	const visibleBody = windowOf(renderedBody, scroll, bodyRows);
	const thumbRows = hasScrollbar ? scrollbarRows(renderedBody.length, bodyRows, scroll) : null;

	// The context row carries the blocked status in the warning color.
	const blockedSuffix = " · blocked";
	const baseWidth = blocked
		? Math.max(0, frame.contentWidth - widthOf(blockedSuffix))
		: frame.contentWidth;

	const liveBody: ModalBody = {
		above: [
			createElement(
				"text",
				{ key: "context" },
				createElement("span", { fg: paint("subtext0") }, truncateToWidth(contextLine, baseWidth)),
				blocked && createElement("span", { fg: paint("yellow") }, blockedSuffix),
			),
		],
		pane:
			layout === null
				? undefined
				: {
						title: decideable ? TURN_LOG_PANE : AGENT_VIEW_PANE,
						rows: visibleBody.map((line, index) =>
							createElement(
								"text",
								{ key: `body-${index}` },
								...bodyRowSpans(line, bodyWidth, thumbRows?.has(index)),
							),
						),
						vpad: panePadding,
						height: layout.paneRows + PANE_BORDERS + 2 * panePadding,
					},
		below: [
			...(held
				? [
						createElement(
							"text",
							{ key: "held", fg: paint("yellow") },
							truncateToWidth(turnEndCauseLine(cause, detail), frame.contentWidth),
						),
					]
				: []),
			...region.window.map((row) =>
				createElement(ActionItem, {
					key: row.key,
					row,
					focused: actions[region.at] === row,
					width: frame.contentWidth,
				}),
			),
		],
		minRows: CONTEXT_ROWS + (held ? 1 : 0) + PANE_BORDERS + BODY_MIN + Math.min(1, regionRows),
	};

	return createElement(ModalSurface, {
		frame,
		width: terminalWidth,
		// The border re-titles `Live:` to `Decision:` when the turn settles
		// for the operator: the prefix is the chrome's, so both paths into
		// the decision end at one screen with one name (ADR 0040).
		title: decideable ? decisionTitle(title) : liveTitle(title),
		opacity: pop,
		body: liveBody,
		message,
		bar: {
			mode,
			context: contextFor(mode, surfaceContext),
			rangeIndicator: region.rangeText,
		},
	});
}
