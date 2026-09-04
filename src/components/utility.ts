/** The mutually exclusive Key guide and Message view utility overlays. */
import { createElement, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import { useControlDispatch } from "./control-dispatch.ts";
import {
	availabilityFor,
	type ControlContext,
	contextFor,
	guideControls,
	guideKeyLabel,
	modeTitle,
} from "./controls.ts";
import { type MessageFact, messageColor } from "./messages.ts";
import { ModalSurface, modalFrame } from "./modal-chrome.ts";
import { padToWidth, truncateToWidth, widthOf, wrapToWidth } from "./text.ts";
import { COLORS, prefixForSeverity } from "./theme.ts";

/** Whether the named key moves a window up. */
const upKey = (name: string): boolean => name === "up" || name === "k";

/** The width a utility overlay grows to at most: a guide wider than this is
 *  hard to read, and a short terminal caps its height. */
const UTILITY_MAX_WIDTH = 100;
const UTILITY_MAX_HEIGHT = 24;

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
 * the one control its mode still dispatches, the Message control on F2, and
 * the Message view wires the Help control on F1.
 */
function useUtilityKeys(
	mode: "key-guide" | "message-view",
	context: ControlContext,
	handlers: {
		close: () => void;
		/** The Message control, on the guide's F2. */
		message?: () => void;
		/** The Help control, on the Message view's F1. */
		help?: () => void;
		scroll: (delta: number) => void;
		emergencyExit: () => void;
	},
): void {
	useControlDispatch({
		mode,
		context,
		onEmergencyExit: handlers.emergencyExit,
		handlers: {
			"guide-close": handlers.close,
			"message-close": handlers.close,
			...(handlers.message !== undefined ? { message: handlers.message } : {}),
			...(handlers.help !== undefined ? { help: handlers.help } : {}),
			"guide-scroll": ({ key }) => handlers.scroll(upKey(key.name) ? -1 : 1),
			"message-scroll": ({ key }) => handlers.scroll(upKey(key.name) ? -1 : 1),
		},
	});
}

interface KeyGuideProps {
	context: ControlContext;
	onClose: () => void;
	onMessage?: () => void;
	/** The Message fact the overlay's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
}

export function KeyGuide({ context, onClose, onMessage, message, onEmergencyExit }: KeyGuideProps) {
	const { width, height } = useTerminalDimensions();
	const mode = context.mode;
	// What the guide lists depends on the mode alone; what each row says about
	// availability is read from the live context when the row renders.
	const entries = useMemo(() => guideControls(mode), [mode]);
	const frame = modalFrame(width, height, {
		maxWidth: UTILITY_MAX_WIDTH,
		maxHeight: UTILITY_MAX_HEIGHT,
	});
	const fullTitle = `Key guide - ${modeTitle(mode)}`;
	const modalTitle = widthOf(fullTitle) <= frame.contentWidth ? fullTitle : "Key guide";
	const rows = useMemo(
		() => guideRows(entries, context, frame.contentWidth),
		[entries, context, frame.contentWidth],
	);
	// The first row names the mode the guide catalogs; the rows below it scroll.
	const visibleRows = Math.max(1, frame.contentRows - 1);
	const { scroll, scrollBy } = useClampedScroll(Math.max(0, rows.length - visibleRows));
	const visible = rows.slice(scroll, scroll + visibleRows);

	useUtilityKeys("key-guide", context, {
		close: onClose,
		message: () => onMessage?.(),
		scroll: scrollBy,
		emergencyExit: onEmergencyExit,
	});

	const range = rangeIndicator(scroll, visible.length, rows.length);
	return createElement(ModalSurface, {
		frame,
		width,
		title: modalTitle,
		borderColor: COLORS.borderFocused,
		minContentRows: 1,
		zIndex: 20,
		message,
		bar: {
			mode: "key-guide",
			context: contextFor("key-guide", context),
			rangeIndicator: range,
		},
		children: [
			createElement(
				"text",
				{ key: "mode", fg: COLORS.dim },
				truncateToWidth(modeTitle(mode), frame.contentWidth),
			),
			...visible.map((row, index) =>
				guideRowElement(row, frame.contentWidth, `${scroll}-${index}`),
			),
		],
	});
}

interface MessageViewProps extends KeyGuideProps {
	fact: MessageFact;
	/** The Message view hands its Help and Message keys to the guide. */
	onHelp: () => void;
}

export function MessageView({
	fact,
	context,
	onClose,
	onHelp,
	message,
	onEmergencyExit,
}: MessageViewProps) {
	const { width, height } = useTerminalDimensions();
	const frame = modalFrame(width, height, {
		maxWidth: UTILITY_MAX_WIDTH,
		maxHeight: UTILITY_MAX_HEIGHT,
	});
	const fullTitle = `Message view - ${prefixForSeverity(fact.severity).slice(0, -1)}`;
	const modalTitle = widthOf(fullTitle) <= frame.contentWidth ? fullTitle : "Message view";
	const wrapped = useMemo(
		() =>
			fact.text
				.split("\n")
				.flatMap((line) => (line === "" ? [""] : wrapToWidth(line, frame.contentWidth))),
		[fact, frame.contentWidth],
	);
	const visibleRows = Math.max(1, frame.contentRows);
	const { scroll, scrollBy } = useClampedScroll(Math.max(0, wrapped.length - visibleRows));
	const visible = wrapped.slice(scroll, scroll + visibleRows);

	useUtilityKeys("message-view", context, {
		close: onClose,
		help: onHelp,
		scroll: scrollBy,
		emergencyExit: onEmergencyExit,
	});

	const range = rangeIndicator(scroll, visible.length, wrapped.length);
	return createElement(ModalSurface, {
		frame,
		width,
		title: modalTitle,
		borderColor: fact.severity === "error" ? COLORS.statusError : COLORS.borderFocused,
		minContentRows: 1,
		zIndex: 20,
		message,
		bar: {
			mode: "message-view",
			context: contextFor("message-view", context),
			rangeIndicator: range,
		},
		children: visible.map((line, index) =>
			createElement(
				"text",
				{ key: `${scroll}-${index}`, fg: messageColor(fact) },
				padToWidth(truncateToWidth(line, frame.contentWidth), frame.contentWidth),
			),
		),
	});
}

/** The compact visible-range indicator: first-last/total of the rows. */
function rangeIndicator(scroll: number, visibleCount: number, total: number): string {
	return `${total === 0 ? 0 : scroll + 1}-${Math.min(total, scroll + visibleCount)}/${total}`;
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
	context: ControlContext,
	width: number,
): GuideLine[] {
	const rows: GuideLine[] = [];
	let group = "";
	for (const entry of entries) {
		if (entry.group !== group) {
			group = entry.group;
			rows.push({ kind: "group", group });
		}
		const isCurrent = entry.control.modes.includes(context.mode);
		const availability = isCurrent ? availabilityFor(entry.control, context) : { available: true };
		rows.push({
			kind: "control",
			keys: guideKeyLabel(context.mode, entry.control),
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
	if (row.kind === "group")
		return createElement("text", { key, fg: COLORS.textBright }, truncateToWidth(row.group, width));
	if (row.kind === "reason")
		// A continuation of the control row above it: the reason column owns
		// these cells, and they carry the same dim color.
		return createElement(
			"text",
			{ key, fg: COLORS.dim },
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
		createElement("span", { fg: unavailable ? COLORS.dim : COLORS.borderFocused }, row.keys),
		createElement("span", { fg: unavailable ? COLORS.dim : COLORS.text }, `  ${row.label}`),
		createElement(
			"span",
			{ fg: COLORS.dim },
			truncateToWidth(reason, Math.max(0, width - widthOf(row.keys) - widthOf(`  ${row.label}`))),
		),
	);
}
