/**
 * The pane screen module: the screen fact a read of a pane's screen or of a
 * ticket's turn log hands back, and the shaping of that screen fact at a
 * width (ADR 0147).
 *
 * The module stands at the read seam, between the reader that reads the
 * pane's visible screen from the Agent host and the consumers of the body:
 * the Consultation detail's body, the Live view's stream, and the Decision
 * modal's turn log. The consumers stand on this one interface and shape no
 * body of their own: they hand the module the width the body stands at and
 * read back the shaped lines.
 *
 * The screen fact holds the body the read returned, and a revision that
 * changes only when the read differs from the previous read of the same
 * pane or log. The comparison stands in the reader that owns the previous
 * read, the `PaneScreenReads` for a pane and the `TurnLogReads` for a log:
 * the UI receives the fact and the revision, does no comparison of reads,
 * and keeps no copy of the previous read.
 *
 * The shaping runs once per (revision, width) pair: the ANSI interpretation
 * of an interaction read into a screen of styled lines, the wrap to width of
 * a visible read's plain text, and the markdown interpretation of a log's
 * entries. A render in between reads, a key press, a poll, a spinner frame,
 * at the same revision and width reads the stored shaped lines. The cache
 * drops its entries with the screen fact that asked for them: a differing
 * read moves the revision to a new fact, and the close of the surface that
 * asked for the body lets the fact go.
 */

import type { TurnLogEntry } from "../turn-log.ts";
import { type AnsiLine, renderAnsiScreen } from "./ansi-screen.ts";
import { type MdColors, type MdLine, renderMarkdown } from "./markdown.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import { paint } from "./theme.ts";

/** The kind of read the screen fact stands on. */
export type PaneScreenKind = "visible" | "ansi" | "log";

/**
 * The screen fact a read of a pane's screen or of a ticket's turn log hands
 * back (ADR 0147): the body the read returned, and the revision. The
 * revision changes only when the read differs from the previous read of the
 * same pane or log; the comparison is owned by the read, so a read that
 * returns the same text hands back the same fact and no new revision.
 */
export interface PaneScreen {
	/** `visible`: the pane's screen in text format. `ansi`: the pane's screen in ANSI format, the interaction mode's read. `log`: a ticket's turn log. */
	readonly kind: PaneScreenKind;
	/** The body the read returned: ANSI-stripped for a visible read, the ANSI text for an interaction read. Null on a log read, whose content is its entries. */
	readonly text: string | null;
	/** The log's entries, in order. Null on a pane read. */
	readonly entries: readonly TurnLogEntry[] | null;
	/** Changes only when the read differs from the previous read of the same pane or log. */
	readonly revision: number;
}

/** The screen fact of a visible read: the pane's screen, ANSI-stripped. */
export function visibleScreen(text: string, revision: number): PaneScreen {
	return { kind: "visible", text, entries: null, revision };
}

/** The screen fact of an interaction read: the pane's screen in ANSI format. */
export function ansiScreen(text: string, revision: number): PaneScreen {
	return { kind: "ansi", text, entries: null, revision };
}

/** The screen fact of a turn log's read: the log's entries, in order. */
export function logScreen(entries: readonly TurnLogEntry[], revision: number): PaneScreen {
	return { kind: "log", text: null, entries, revision };
}

/**
 * The previous reads a pane reader owns (ADR 0147): one entry per (host,
 * pane, kind), the text the read answered, and the fact it moved to. The
 * reader is the module that owns the previous read, so the comparison of a
 * read with the previous read of the same pane stands here and nowhere in
 * the UI. A read that answers the same text as the previous read hands back
 * the same screen fact, and a read that differs moves the revision.
 */
export class PaneScreenReads {
	private readonly previous = new Map<string, { text: string; fact: PaneScreen }>();

	/** The screen fact of one read on one host's pane: unchanged while the read answers the same text as the previous read of that pane and kind. */
	read(host: string, paneId: string, kind: "visible" | "ansi", text: string): PaneScreen {
		const key = `${host}\u0000${paneId}\u0000${kind}`;
		const previous = this.previous.get(key);
		if (previous !== undefined && previous.text === text) return previous.fact;
		const fact =
			kind === "visible"
				? visibleScreen(text, (previous?.fact.revision ?? 0) + 1)
				: ansiScreen(text, (previous?.fact.revision ?? 0) + 1);
		this.previous.set(key, { text, fact });
		return fact;
	}
}

/**
 * The previous reads a turn log's read owns (ADR 0147): one entry per
 * ticket, the entries the read answered, and the fact it moved to. The log
 * the Decision modal's turn log and the Live view's decision body stand on
 * is read from the ticket's settled record, and this holder is that read's
 * owner: a read that answers the same entries hands back the same fact, and
 * a read that differs moves the revision.
 */
export class TurnLogReads {
	private readonly previous = new Map<string, { key: string; fact: PaneScreen }>();

	/** The screen fact of one ticket's log read: unchanged while the read answers the same entries as the previous read of that ticket's log. */
	read(ticket: string, entries: readonly TurnLogEntry[]): PaneScreen {
		const key = JSON.stringify(entries);
		const previous = this.previous.get(ticket);
		if (previous !== undefined && previous.key === key) return previous.fact;
		const fact = logScreen(entries, (previous?.fact.revision ?? 0) + 1);
		this.previous.set(ticket, { key, fact });
		return fact;
	}
}

/** The shaped body one (screen fact, width) pair stands on (ADR 0147). */
interface ShapedPaneScreen {
	text?: string[];
	ansi?: AnsiLine[];
	log?: MdLine[];
}

/**
 * The store of shaped bodies: one entry per screen fact, and one shaped
 * body per width the fact has stood on. A fact that no surface holds any
 * more drops its entries with it, so the store keeps no entry past its
 * (revision, width) key.
 */
const shapes = new WeakMap<PaneScreen, Map<number, ShapedPaneScreen>>();

function shapedAt(screen: PaneScreen, width: number): ShapedPaneScreen {
	let byWidth = shapes.get(screen);
	if (byWidth === undefined) {
		byWidth = new Map();
		shapes.set(screen, byWidth);
	}
	let slot = byWidth.get(width);
	if (slot === undefined) {
		slot = {};
		byWidth.set(width, slot);
	}
	return slot;
}

/**
 * The plain text lines a visible screen fact wears at the width: each line
 * of the body wrapped to the width. Shaped once per (revision, width) pair;
 * a render at the same pair reads the stored lines (ADR 0147).
 */
export function visibleScreenLines(screen: PaneScreen, width: number): string[] {
	const slot = shapedAt(screen, width);
	if (slot.text !== undefined) return slot.text;
	if (screen.text === null) throw new Error("a screen fact holds no body");
	const lines = shapeVisibleText(screen.text, width);
	slot.text = lines;
	return lines;
}

/**
 * The parsed screen of an interaction screen fact at the width: the ANSI
 * interpretation of the pane's text into a screen of styled lines. Shaped
 * once per (revision, width) pair; a render at the same pair reads the
 * stored screen (ADR 0147).
 */
export function ansiScreenLines(screen: PaneScreen, width: number): AnsiLine[] {
	const slot = shapedAt(screen, width);
	if (slot.ansi !== undefined) return slot.ansi;
	if (screen.text === null) throw new Error("a screen fact holds no body");
	const lines = renderAnsiScreen(screen.text, width);
	slot.ansi = lines;
	return lines;
}

/**
 * The turn log's lines at the width: the entries shaped by the log's own
 * rules, text entries interpreted with the markdown rules and tool calls as
 * one dim note each. Shaped once per (revision, width) pair; a render at
 * the same pair reads the stored lines (ADR 0147).
 */
export function logScreenLines(screen: PaneScreen, width: number): MdLine[] {
	const slot = shapedAt(screen, width);
	if (slot.log !== undefined) return slot.log;
	if (screen.entries === null) throw new Error("a screen fact holds no log");
	const lines = shapeLogEntries(screen.entries, width);
	slot.log = lines;
	return lines;
}

/**
 * The lines a visible screen's body shapes to at the width: each line of
 * the body wrapped to the width, one shaping per line. A blank line of the
 * body stands as one blank line: a body the operator's pane shows empty
 * keeps its empty rows. A pure function of the body and the width: no
 * terminal, no host, no renderer.
 */
export function shapeVisibleText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const raw of text.split("\n")) {
		if (raw === "") {
			lines.push("");
			continue;
		}
		for (const wrapped of wrapToWidth(raw, width)) lines.push(truncateToWidth(wrapped, width));
	}
	return lines;
}

/**
 * The turn log's lines at the width: text entries render with the markdown
 * rules, tool calls are one dim note, "▸ name: target". A blank line stands
 * between two text blocks; a tool note sits close to the text that asked
 * for it. Failed calls wear the warning color. A pure function of the
 * entries and the width: no terminal, no host, no renderer.
 */
export function shapeLogEntries(entries: readonly TurnLogEntry[], width: number): MdLine[] {
	// The log's voices are asked of the theme when the log is shaped, the
	// way every other surface paints: a resolution that changes after this
	// module loads is the resolution the lines paint.
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
