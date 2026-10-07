/** The mutually exclusive Key guide and Message view utility overlays. */
import { createElement, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import { useControlDispatch } from "./control-dispatch.ts";
import {
	type AvailabilityFacts,
	availabilityFacts,
	availabilityFor,
	guideControls,
	guideKeyLabel,
	modeTitle,
	type StandingFacts,
} from "./controls.ts";
import { maxScrollOf, windowOf } from "./geometry.ts";
import type { MessageHistoryEntry } from "./message-facts.ts";
import type { MessageFact } from "./messages.ts";
import {
	type BodySpan,
	bodyRowSpans,
	ModalSurface,
	modalFrame,
	scrollbarRows,
} from "./modal-chrome.ts";
import { controlInk } from "./shared/presentation.ts";
import { bodyPaneFacts, rangeTextOf } from "./shared/region.ts";
import { padToWidth, truncateToWidth, widthOf, wrapToWidth } from "./text.ts";
import { paint } from "./theme.ts";

/** Whether the named key moves a window up. */
const upKey = (name: string): boolean => name === "up" || name === "k";

/** The width a utility overlay grows to at most: a guide wider than this is
 *  hard to read, and a short terminal caps its height. */
const UTILITY_MAX_WIDTH = 100;
const UTILITY_MAX_HEIGHT = 24;

/** The cells the Body pane's border takes, the one the modals pay. */
const PANE_BORDERS = 2;

/** The shared scroll clamp: content changes never leave the cursor past the end. */
function useClampedScroll(maxScroll: number) {
	const [scroll, setScroll] = useState(0);
	useEffect(() => {
		setScroll((current) => Math.min(current, maxScroll));
	}, [maxScroll]);
	return {
		scroll: Math.min(scroll, maxScroll),
		scrollBy: (delta: number) =>
			setScroll((current) => Math.max(0, Math.min(maxScroll, current + delta))),
	};
}

/**
 * The keys of one utility overlay, through the shared catalogue hook.
 *
 * A refusal stays silent here: an overlay answers only with keys it always
 * holds (its close keys, Help, and Scroll), so there is no refusal worth a
 * Warning. The wiring mirrors the catalogue routing, and nothing else: the
 * close control outranks the shared keys, so F1 and ? resolve to
 * guide-close (not to the Help it would only close again) and F2 resolves to
 * message-close (not to the Message it would only reopen). The guide wires
 * the one control its mode still dispatches, the Message control on F2, the
 * Message view wires the Help control on F1, and the Message view's body
 * scrolls through the shared body scroll, `scroll-body`.
 */
function useUtilityKeys(
	facts: AvailabilityFacts,
	handlers: {
		close: () => void;
		/** The Message control, on the guide's F2. */
		message?: () => void;
		/** The Help control, on the Message view's F1. */
		help?: () => void;
		/** The guide's own scroll, on its ↑/↓ and j/k. */
		scroll?: (delta: number) => void;
		/** The shared body scroll, on the Message view's j/k and page keys. */
		scrollBody?: (name: string) => void;
		emergencyExit: () => void;
		/**
		 * The plane-level keys on the overlay (issue #319, ADR 0111): the brake
		 * and the mode flip reach the Key guide and the Message view the way they
		 * reach the modals, and the overlay's border lamp reads the facts the
		 * toggle writes. Wired on the keys the overlay's mode carries, so the
		 * guide's close and the view's help keep their own routing.
		 */
		queuePause?: () => void;
		autoHandoff?: () => void;
	},
): void {
	const guideScroll = handlers.scroll;
	const bodyScrollHandler = handlers.scrollBody;
	useControlDispatch({
		facts,
		onEmergencyExit: handlers.emergencyExit,
		handlers: {
			"guide-close": handlers.close,
			"message-close": handlers.close,
			...(handlers.message !== undefined ? { message: handlers.message } : {}),
			...(handlers.help !== undefined ? { help: handlers.help } : {}),
			...(guideScroll !== undefined
				? {
						"guide-scroll": ({ key }: { key: { name: string } }) =>
							guideScroll(upKey(key.name) ? -1 : 1),
					}
				: {}),
			...(bodyScrollHandler !== undefined
				? { "scroll-body": ({ key }: { key: { name: string } }) => bodyScrollHandler(key.name) }
				: {}),
			...(handlers.queuePause !== undefined ? { "queue-pause": handlers.queuePause } : {}),
			...(handlers.autoHandoff !== undefined ? { "auto-handoff": handlers.autoHandoff } : {}),
		},
	});
}

interface KeyGuideProps {
	facts: AvailabilityFacts;
	onClose: () => void;
	onMessage?: () => void;
	/** The Message fact the overlay's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
	/**
	 * The Queue pause's key on this overlay (issue #319, ADR 0111): the brake
	 * reaches the Key guide the way it reaches the modals. Required, because a
	 * surface that resolves the key and swallows it would be a key the plane
	 * takes and never answers.
	 */
	onQueuePause: () => void;
	/**
	 * The Auto-handoff mode's key on this overlay (issue #319, ADR 0111): required
	 * for the same reason.
	 */
	onAutoHandoff: () => void;
}

export function KeyGuide({
	facts,
	onClose,
	onMessage,
	message,
	onEmergencyExit,
	onQueuePause,
	onAutoHandoff,
}: KeyGuideProps) {
	const { width, height } = useTerminalDimensions();
	const mode = facts.mode;
	// The guide's own mode owns no rows, so it states no facts of its own
	// beside the plane's standing facts.
	const guideFacts = availabilityFacts("key-guide", facts, {});
	// What the guide lists depends on the mode alone; what each row says about
	// availability is read from the live facts when the row renders.
	const entries = useMemo(() => guideControls(facts), [facts]);
	const frame = modalFrame(width, height, {
		maxWidth: UTILITY_MAX_WIDTH,
		maxHeight: UTILITY_MAX_HEIGHT,
	});
	const fullTitle = `Key guide - ${modeTitle(mode)}`;
	const modalTitle = widthOf(fullTitle) <= frame.contentWidth ? fullTitle : "Key guide";
	const rows = useMemo(
		() => guideRows(entries, facts, frame.contentWidth),
		[entries, facts, frame.contentWidth],
	);
	// The first row names the mode the guide catalogs; the rows below it scroll.
	const visibleRows = Math.max(1, frame.contentRows - 1);
	const { scroll, scrollBy } = useClampedScroll(Math.max(0, rows.length - visibleRows));
	const visible = rows.slice(scroll, scroll + visibleRows);

	useUtilityKeys(guideFacts, {
		close: onClose,
		message: () => onMessage?.(),
		scroll: scrollBy,
		emergencyExit: onEmergencyExit,
		queuePause: onQueuePause,
		autoHandoff: onAutoHandoff,
	});

	// The compact readout the bar states behind the Scroll hint: the shared
	// range text, the one the Decision region's bar carries too.
	const range = rangeTextOf(scroll, visible.length, rows.length);
	const ink = controlInk();
	return createElement(ModalSurface, {
		frame,
		width,
		title: modalTitle,
		body: {
			above: [
				createElement(
					"text",
					{ key: "mode", fg: ink.detail.fg ?? undefined },
					truncateToWidth(modeTitle(mode), frame.contentWidth),
				),
			],
			below: visible.map((row, index) =>
				guideRowElement(row, frame.contentWidth, `${scroll}-${index}`),
			),
			minRows: 1,
		},
		zIndex: 20,
		message,
		bar: {
			mode: "key-guide",
			facts: guideFacts,
			rangeIndicator: range,
		},
		queuePaused: facts.queuePaused,
	});
}

/**
 * The Message view, the Message line's own record of the run (ADR 0119).
 *
 * It shows the run's Message history, oldest first and newest at the bottom, and
 * opens pinned to the newest entry. The frame is the near-fullscreen box the
 * Decision modal uses, and the history rides the shared Body pane titled
 * `Messages`: the same pane, the same window, and the same body scroll the
 * modal's turn log holds. The Key guide keeps its own 100 by 24 frame.
 *
 * A row wears three cells in fixed width: the datetime of the entry's write,
 * `YYYY-MM-DD HH:MM:SS`, the five-cell level chip of its severity,
 * `INFO`, `WARN`, or `ERROR`, and the entry's text, wrapped to the
 * remaining width, indented under the chip on its continuation rows. The chip
 * wears the color of the severity it names, and the view is the live
 * history: an entry that lands while it stands shows at the bottom, and a
 * source health that clears or recovers reads the way it did on the line.
 */

// The Message view's frame: the near-fullscreen box, the margin the
// Decision modal's box keeps from the terminal's edges.
const MESSAGE_VIEW_MARGIN = 1;

// The fixed-width cells of a history row: the datetime takes nineteen cells,
// the chip its five, and the text starts one cell past the chip.
const HISTORY_TIME_WIDTH = 19;
const HISTORY_CHIP_WIDTH = 5;
const HISTORY_TEXT_INDENT = HISTORY_TIME_WIDTH + 1 + HISTORY_CHIP_WIDTH;

/**
 * The datetime a history entry wears, in the entry's local time: the fixed
 * nineteen cells `YYYY-MM-DD HH:MM:SS`.
 */
export function historyEntryTime(at: number): string {
	const d = new Date(at);
	const cell = (value: number, digits: number) => String(value).padStart(digits, "0");
	return (
		`${cell(d.getFullYear(), 4)}-${cell(d.getMonth() + 1, 2)}-${cell(d.getDate(), 2)}` +
		` ${cell(d.getHours(), 2)}:${cell(d.getMinutes(), 2)}:${cell(d.getSeconds(), 2)}`
	);
}

/** The chip the entry's severity wears, padded to the chip's five cells. */
export function historyChip(severity: MessageHistoryEntry["severity"]): string {
	const face = severity === "info" ? "INFO" : severity === "warning" ? "WARN" : "ERROR";
	return face.padEnd(HISTORY_CHIP_WIDTH);
}

/** The color the chip of one severity wears: red, yellow, and the theme's text. */
export function historyChipColor(severity: MessageHistoryEntry["severity"]): string | undefined {
	return severity === "error"
		? paint("red")
		: severity === "warning"
			? paint("yellow")
			: paint("text");
}

/**
 * The body rows one history occupies, at the width the pane holds, oldest
 * first. Each entry leads with its datetime, its chip, and its text's first
 * row, and wraps its text to the width left of the chip's column, its
 * continuation rows indented under the text. An entry with no text keeps its
 * datetime and chip alone.
 */
export function messageHistoryBody(
	history: readonly MessageHistoryEntry[],
	width: number,
): BodySpan[][] {
	const rows: BodySpan[][] = [];
	const timeColor = paint("subtext0");
	const textColor = paint("text");
	const textWidth = Math.max(1, width - HISTORY_TEXT_INDENT);
	for (const entry of history) {
		const time = historyEntryTime(entry.at);
		const chip = historyChip(entry.severity);
		const chipColor = historyChipColor(entry.severity);
		const textLines = entry.text
			.split("\n")
			.flatMap((line) => (line === "" ? [""] : wrapToWidth(line, textWidth)));
		const body = textLines.length === 0 ? [""] : textLines;
		body.forEach((line, index) => {
			const spans: BodySpan[] =
				index === 0
					? [{ text: time, fg: timeColor }, { text: " " }, { text: chip, fg: chipColor }]
					: [{ text: " ".repeat(HISTORY_TEXT_INDENT) }];
			spans.push({ text: line, fg: textColor });
			rows.push(spans);
		});
	}
	return rows;
}

interface MessageViewProps {
	/**
	 * The plane's standing facts: the view builds its own mode facts from them,
	 * beside the body facts it owns, the way the modals and the Live view do.
	 */
	facts: StandingFacts;
	/** The run's Message history, oldest first: the record the view shows. */
	history: readonly MessageHistoryEntry[];
	/** The Message fact the overlay's own Message line shows. */
	message: MessageFact | null;
	onClose: () => void;
	/** The Message view hands its Help key to the guide. */
	onHelp: () => void;
	onEmergencyExit: () => void;
	/**
	 * The Queue pause's key on this view (issue #319, ADR 0111): the brake
	 * reaches the view the way it reaches the modals.
	 */
	onQueuePause: () => void;
	/**
	 * The Auto-handoff mode's key on this view (issue #319, ADR 0111). Required
	 * for the same reason.
	 */
	onAutoHandoff: () => void;
}

export function MessageView({
	history,
	facts,
	message,
	onClose,
	onHelp,
	onEmergencyExit,
	onQueuePause,
	onAutoHandoff,
}: MessageViewProps) {
	const { width, height } = useTerminalDimensions();
	// The near-fullscreen frame the Decision modal uses: the room the terminal
	// offers above the bar, the same margin, and no cap. The pane's chrome
	// yields before the history yields rows: padding first, and the scrollbar
	// is decided at the final size, so the thumb does not flicker in and out
	// while a row lands.
	const frame = modalFrame(width, height, { margin: MESSAGE_VIEW_MARGIN });
	const panePadding: 0 | 1 = frame.padding === 1 ? 1 : 0;
	const paneInnerWidth = Math.max(1, frame.contentWidth - PANE_BORDERS - 2 * panePadding);
	const visibleRows = Math.max(0, frame.contentRows - PANE_BORDERS - 2 * panePadding);
	const fullWidthBody = useMemo(
		() => messageHistoryBody(history, paneInnerWidth),
		[history, paneInnerWidth],
	);
	const hasScrollbar = fullWidthBody.length > visibleRows;
	const bodyWidth = Math.max(1, paneInnerWidth - (hasScrollbar ? 1 : 0));
	const body = useMemo(() => messageHistoryBody(history, bodyWidth), [history, bodyWidth]);
	const maxScroll = maxScrollOf(body.length, visibleRows);
	// The view opens pinned to the newest entry: `null` keeps it there while
	// entries land, and the operator's first step takes a real index.
	const [bodyScroll, setBodyScroll] = useState<number | null>(null);

	// Scroll the body by one step of the named key: a page moves one viewport,
	// and the jump keys take either edge. A null view is the bottom, so the
	// first step reads the bottom's index.
	const scrollBody = (name: string) => {
		if (name === "pageup")
			setBodyScroll((current) => Math.max(0, (current ?? maxScroll) - Math.max(1, visibleRows)));
		else if (name === "pagedown")
			setBodyScroll((current) =>
				Math.min(maxScroll, (current ?? maxScroll) + Math.max(1, visibleRows)),
			);
		else if (name === "home") setBodyScroll(0);
		else if (name === "end") setBodyScroll(maxScroll);
		else if (name === "j")
			setBodyScroll((current) => Math.min((current ?? maxScroll) + 1, maxScroll));
		else setBodyScroll((current) => Math.max(0, (current ?? maxScroll) - 1));
	};

	// The view states the facts its own body produces, beside the plane's
	// standing facts: the pane's window, the shared fact the bar's gate and
	// its range text read.
	const viewFacts = availabilityFacts(
		"message-view",
		facts,
		bodyPaneFacts(body.length, visibleRows, history.length === 0),
	);

	useUtilityKeys(viewFacts, {
		close: onClose,
		help: onHelp,
		scrollBody,
		emergencyExit: onEmergencyExit,
		queuePause: onQueuePause,
		autoHandoff: onAutoHandoff,
	});

	const scroll = bodyScroll === null ? maxScroll : Math.min(bodyScroll, maxScroll);
	const visible = windowOf(body, scroll, visibleRows);
	const range = rangeTextOf(scroll, visible.length, body.length);
	// The Decision modal's thumb, on the view's own window: the gutter holds
	// the track and the thumb the position it wears, not a blank column.
	const thumbRows = hasScrollbar ? scrollbarRows(body.length, visibleRows, scroll) : null;

	return createElement(ModalSurface, {
		frame,
		width,
		title: "Message view",
		body: {
			above: [],
			pane: {
				title: "Messages",
				rows: visible.map((line, index) =>
					createElement(
						"text",
						{ key: `${scroll}-${index}` },
						...bodyRowSpans(line, bodyWidth, thumbRows?.has(index)),
					),
				),
				vpad: panePadding,
				height: visibleRows + PANE_BORDERS + 2 * panePadding,
			},
			below: [],
			minRows: PANE_BORDERS + 1,
		},
		zIndex: 20,
		message,
		bar: {
			mode: "message-view",
			facts: viewFacts,
			rangeIndicator: range,
		},
		queuePaused: facts.queuePaused,
	});
}

type GuideLine =
	| { kind: "group"; group: string }
	| {
			kind: "control";
			keys: string;
			label: string;
			reason?: string;
			/** Whether this row states a control the app will not run here. */
			dimmed: boolean;
			/** The cell this row's reason starts at, once it is flowed. */
			indent?: number;
	  }
	/** The rest of a control row's reason, indented to its reason column. */
	| { kind: "reason"; text: string; indent: number };

function guideRows(
	entries: ReturnType<typeof guideControls>,
	facts: AvailabilityFacts,
	width: number,
): GuideLine[] {
	const rows: GuideLine[] = [];
	let group = "";
	for (const entry of entries) {
		if (entry.group !== group) {
			group = entry.group;
			rows.push({ kind: "group", group });
		}
		const isCurrent = entry.control.modes.includes(facts.mode);
		const availability = isCurrent ? availabilityFor(entry.control, facts) : { available: true };
		rows.push({
			kind: "control",
			keys: guideKeyLabel(facts.mode, entry.control, facts),
			label: entry.control.label,
			// A control that is always available carries its guide note; a
			// current-mode control carries its live unavailable reason. Other
			// modes state behavior, never a guessed availability claim. The row
			// dims on the availability, never on which note it happens to carry:
			// a guide note is a fact about the control, not a refusal.
			reason: availability.available ? entry.control.guideNote : availability.reason,
			dimmed: !availability.available,
		});
	}
	return flowGuideRows(rows, width);
}

/**
 * Fit every guide row to the width, with both text columns sized to content.
 *
 * The key column and the label column each take the width of their widest
 * entry, so a reason gets every cell the controls do not need. A reason that
 * still does not fit flows onto continuation rows indented to its own column:
 * no reason is ever cut silently, at any size. The columns stay aligned on
 * every row of the guide, because they come from one pass over all rows.
 */
function flowGuideRows(rows: GuideLine[], width: number): GuideLine[] {
	const entries = rows.filter(
		(row): row is Extract<GuideLine, { kind: "control" }> => row.kind === "control",
	);
	const widestKeys = Math.max(1, ...entries.map((row) => widthOf(row.keys)));
	const widestLabel = Math.max(1, ...entries.map((row) => widthOf(row.label)));
	// Neither text column may take more than a third of a narrow guide: the
	// reason has to keep room to flow, and the guide cannot scroll sideways.
	const columnCap = Math.max(1, Math.floor((Math.max(1, width) - 2) / 3));
	const keyWidth = Math.min(widestKeys, columnCap);
	const labelWidth = Math.min(widestLabel, Math.max(1, width - keyWidth - 2));
	// The cell a reason starts at: after both columns, the two spaces that
	// separate them, and the " - " separator. A guide too narrow for that
	// keeps a quarter of its cells for the reason, so a long reason flows
	// onto its own rows instead of vanishing.
	const textReasonStart = keyWidth + labelWidth + 5;
	const reasonStart = Math.min(
		textReasonStart,
		Math.max(0, width - Math.max(1, Math.floor(width / 4))),
	);
	const out: GuideLine[] = [];
	for (const row of rows) {
		if (row.kind !== "control") {
			out.push(row);
			continue;
		}
		const keys = padToWidth(truncateToWidth(row.keys, keyWidth), keyWidth);
		const label = padToWidth(truncateToWidth(row.label, labelWidth), labelWidth);
		const lines =
			row.reason === undefined || row.reason === ""
				? []
				: wrapToWidth(row.reason, Math.max(1, width - reasonStart));
		// The first line shares the control row only while the reason column
		// is still where the row draws it, and the separator and that line
		// both fit after the two text columns. A guide that had to pull the
		// column left gives the reason rows of their own instead of drawing a
		// first line the row cannot hold.
		const sharesRow =
			lines.length > 0 &&
			reasonStart === textReasonStart &&
			widthOf(` - ${lines[0] ?? ""}`) <= Math.max(0, width - keyWidth - labelWidth - 2);
		if (sharesRow) out.push({ ...row, keys, label, reason: lines[0], indent: reasonStart });
		else out.push({ ...row, keys, label, reason: undefined, indent: reasonStart });
		for (const line of lines.slice(sharesRow ? 1 : 0))
			out.push({ kind: "reason", text: line, indent: reasonStart });
	}
	return out;
}

function guideRowElement(row: GuideLine, width: number, key: string): ReactElement {
	const ink = controlInk();
	if (row.kind === "group")
		return createElement(
			"text",
			{ key, fg: ink.focusedText.fg ?? undefined },
			truncateToWidth(row.group, width),
		);
	if (row.kind === "reason")
		// A continuation of the control row above it: the reason column owns
		// these cells, and they carry the same dim color.
		return createElement(
			"text",
			{ key, fg: ink.detail.fg ?? undefined },
			padToWidth(
				`${" ".repeat(Math.max(0, row.indent))}${truncateToWidth(row.text, Math.max(1, width - row.indent))}`,
				width,
			),
		);
	const unavailable = row.dimmed;
	const reason = row.reason === undefined ? "" : ` - ${row.reason}`;
	return createElement(
		"text",
		{ key },
		createElement(
			"span",
			{ fg: (unavailable ? ink.detail : ink.indicator).fg ?? undefined },
			row.keys,
		),
		createElement(
			"span",
			{ fg: (unavailable ? ink.detail : ink.text).fg ?? undefined },
			`  ${row.label}`,
		),
		createElement(
			"span",
			{ fg: ink.detail.fg ?? undefined },
			truncateToWidth(reason, Math.max(0, width - widthOf(row.keys) - widthOf(`  ${row.label}`))),
		),
	);
}
