/**
 * The Live view: the agent's terminal, streamed, above an in-flight ticket.
 *
 * The control plane opens it on a `handed-off` or `running` ticket. It is
 * the Decision modal's shape - near-fullscreen, one cell of margin, the
 * pop-in, the context line, the scrolling body, the action rows, the hint
 * line - with the body swapped for the agent's live terminal output: plain
 * text, the tail the completion-message-lines setting names, refreshed at
 * the one-second cadence.
 *
 * While the agent works, the body is the stream and the one row is Goto.
 * When the turn settles and the factory waits for the operator's decision,
 * the same box carries the decision sub-mode: the turn log's body, the
 * decision's action rows, and their keys. Watching flows into deciding
 * without a screen change.
 *
 * The stream's keys: j/k scroll the body one row, pgup and pgdn page it,
 * home and end jump to its ends, enter confirms the Goto, and esc cancels.
 * The decision sub-mode adds the Decision modal's: up and down move the
 * action rows, and e edits a selected handoff row. The bottom pin holds
 * while new output arrives; any manual scroll releases it.
 */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useMemo, useRef, useState } from "react";

import type { TurnLogEntry } from "../turn-log.ts";
import {
	actionSpans,
	bodySpans,
	DECISION_HINT,
	decisionBoxSize,
	decisionLayout,
	scrollbarRows,
	turnLogBody,
	useModalPopIn,
} from "./decision-modal.ts";
import { maxScrollOf, windowOf } from "./geometry.ts";
import type { MdLine, MdSpan } from "./markdown.ts";
import type { ActionRow } from "./missing-modal.ts";
import { truncateToWidth, widthOf, wrapToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

/** The stream's hint: the scroll keys, enter, and esc. No row selection. */
const STREAM_HINT = "j/k scroll  pgup/pgdn page  home/end  enter goto  esc";

/** The body the Live view box shows. */
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
	body: LiveViewBody;
	/** The action rows at the bottom of the box. */
	actions: readonly ActionRow[];
	/** True in the decision sub-mode: row selection and e edit are live. */
	decideable: boolean;
	onAction: (key: string) => void;
	/** The `e` key on a row flagged editable: change its Handoff's settings. */
	onEditAction?: (key: string) => void;
	onCancel: () => void;
}

/** One stream row as styled lines: plain text, the palette's prose voice. */
function streamLines(lines: readonly string[], note: string | null, width: number): MdLine[] {
	const out: MdLine[] = lines.flatMap((line) => {
		if (line === "") return [[]];
		return wrapToWidth(line, width).map<MdLine>((row) => [
			{ text: row, fg: COLORS.text } satisfies MdSpan,
		]);
	});
	// A failed read keeps the last lines, with the stale note under them.
	if (note !== null) out.push([{ text: note, fg: COLORS.dim }]);
	return out;
}

/** The box's body at a width: the turn log's rows, or the stream's. */
function buildBodyLines(body: LiveViewBody, width: number): MdLine[] {
	return body.kind === "turn-log"
		? turnLogBody(body.entries, width)
		: streamLines(body.lines, body.note, width);
}

export function LiveView({
	title,
	contextLine,
	blocked,
	body,
	actions,
	decideable,
	onAction,
	onEditAction,
	onCancel,
}: LiveViewProps) {
	const hint = decideable ? DECISION_HINT : STREAM_HINT;
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	// The box size the pop-in grows into, decided at the terminal's size. The
	// content layout follows the box while it grows; the hint and the
	// scrollbar are decided at the final size, so neither flickers in and
	// out during the pop.
	const finalBox = decisionBoxSize(terminalWidth, terminalHeight);
	const finalLayout = useMemo(
		() => decisionLayout(finalBox.width, finalBox.height, actions.length, hint),
		[finalBox.width, finalBox.height, actions.length, hint],
	);
	const { pop, boxWidth, boxHeight } = useModalPopIn(finalBox.width, finalBox.height);
	const geometry = decisionLayout(boxWidth, boxHeight, actions.length, hint);

	// Reserve a column for the scrollbar only when the body needs one. A
	// scrollbar can add wrap rows, so determine overflow once at the final
	// width, then make the final window from the narrower text width.
	const fullWidthBody = useMemo(
		() => buildBodyLines(body, finalLayout.contentWidth),
		[body, finalLayout.contentWidth],
	);
	const hasScrollbar = fullWidthBody.length > finalLayout.bodyRows;
	const bodyWidth = Math.max(1, geometry.contentWidth - (hasScrollbar ? 1 : 0));
	// Wrap at the width the box has right now, so a line is never wider
	// than the frame being drawn while the pop-in grows the box.
	const renderedBody = useMemo(() => buildBodyLines(body, bodyWidth), [body, bodyWidth]);
	const bodyRows = Math.min(renderedBody.length, geometry.bodyRows);
	const maxBodyScroll = maxScrollOf(renderedBody.length, bodyRows);

	// The newest output is in front: the body opens at its bottom and stays
	// pinned to it while new rows arrive, until the operator scrolls.
	const [bodyScroll, setBodyScroll] = useState<number | null>(null);
	const [selected, setSelected] = useState(0);
	const selectedRef = useRef(0);

	const move = (delta: number) => {
		if (decideable === false || actions.length === 0) return;
		const next = (selectedRef.current + delta + actions.length) % actions.length;
		selectedRef.current = next;
		setSelected(next);
	};

	useKeyboard((key) => {
		if (key.ctrl || key.meta) return;
		switch (key.name) {
			case "escape":
				onCancel();
				break;
			case "return": {
				const action = actions[Math.min(selectedRef.current, actions.length - 1)];
				if (action !== undefined) onAction(action.key);
				break;
			}
			case "e": {
				if (decideable === false || onEditAction === undefined) break;
				const action = actions[Math.min(selectedRef.current, actions.length - 1)];
				if (action !== undefined && action.editable === true) onEditAction(action.key);
				break;
			}
			case "down":
				move(1);
				break;
			case "up":
				move(-1);
				break;
			case "j":
				// Scrolling back to the bottom re-pins the stream: new output
				// comes into view again without the operator asking.
				setBodyScroll((s) => {
					const next = Math.min((s === null ? maxBodyScroll : s) + 1, maxBodyScroll);
					return next >= maxBodyScroll ? null : next;
				});
				break;
			case "k":
				setBodyScroll((s) => Math.max((s === null ? maxBodyScroll : s) - 1, 0));
				break;
			case "pageup":
				setBodyScroll((s) => Math.max((s === null ? maxBodyScroll : s) - bodyRows, 0));
				break;
			case "pagedown":
				setBodyScroll((s) => {
					const next = Math.min((s === null ? maxBodyScroll : s) + bodyRows, maxBodyScroll);
					return next >= maxBodyScroll ? null : next;
				});
				break;
			case "home":
				setBodyScroll(0);
				break;
			case "end":
				setBodyScroll(maxBodyScroll);
				break;
		}
	});

	const scroll = bodyScroll === null ? maxBodyScroll : Math.min(bodyScroll, maxBodyScroll);
	const visibleBody = windowOf(renderedBody, scroll, bodyRows);
	const thumbRows = hasScrollbar ? scrollbarRows(renderedBody.length, bodyRows, scroll) : null;

	// The context line carries the blocked status in the warning color.
	const blockedSuffix = " · blocked";
	const baseWidth = blocked
		? Math.max(0, geometry.contentWidth - widthOf(blockedSuffix))
		: geometry.contentWidth;

	return createElement(
		"box",
		{
			style: {
				position: "absolute",
				top: 0,
				left: 0,
				width: terminalWidth,
				height: terminalHeight,
				zIndex: 10,
				backgroundColor: COLORS.overlay,
				alignItems: "center",
				justifyContent: "center",
			},
		},
		createElement(
			"box",
			{
				border: true,
				borderColor: COLORS.borderFocused,
				title: truncateToWidth(`Live: ${title}`, geometry.contentWidth),
				padding: 1,
				style: {
					flexDirection: "column",
					width: boxWidth,
					height: boxHeight,
					opacity: pop,
				},
			},
			createElement(
				"text",
				{ key: "context" },
				createElement("span", { fg: COLORS.dim }, truncateToWidth(contextLine, baseWidth)),
				blocked && createElement("span", { fg: COLORS.statusWarning }, blockedSuffix),
			),
			...visibleBody.map((line, index) =>
				createElement(
					"text",
					{ key: `body-${index}` },
					...bodySpans(line, bodyWidth, thumbRows?.has(index)),
				),
			),
			...actions.map((row, index) =>
				createElement(
					"text",
					{ key: row.key },
					...actionSpans(row, index === selected, geometry.contentWidth),
				),
			),
			finalLayout.showHint &&
				createElement("text", { fg: COLORS.dim }, truncateToWidth(hint, geometry.contentWidth)),
		),
	);
}
