/**
 * Light markdown dressing for the turn log.
 *
 * The agent's text is raw markdown. The decision modal renders it with a
 * small deterministic rule set, in the shared palette:
 *
 * - Headings: bright text, the "#" marks drop.
 * - Bold: bright text. Italic: normal text.
 * - Inline code: dim. Code blocks: dim, indented two, the fences drop.
 * - Lists: the marker stays, two cells of indent per level.
 * - Links: the label only, the URL drops. Images: the alt text.
 * - Horizontal rules: a blank line.
 * - Anything else: the markup drops, the text stays.
 *
 * The output is wrapped styled lines: each line is a list of spans with a
 * foreground color, so the modal can paint them directly. Wrapping runs on
 * styled words, so a color never breaks mid-word and a wide word is cut on
 * grapheme boundaries like every other pane.
 */
import { widthOf } from "./text.ts";

/** One styled piece of a log line. The fg is a palette placeholder until painted. */
export interface MdSpan {
	text: string;
	fg: string;
}

/** One wrapped line of rendered markdown. An empty list is a blank line. */
export type MdLine = readonly MdSpan[];

/** The palette the dressing uses: the log's three voices. */
export interface MdColors {
	/** Normal prose. */
	text: string;
	/** Headings and bold. */
	bright: string;
	/** Code, the block version and the inline one. */
	dim: string;
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function graphemes(text: string): string[] {
	return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** The inline markup: code, bold, italic, link, image, in priority order. */
const INLINE =
	/(`[^`\n]*`)|(\*\*\*[^*\n]+\*\*\*)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s\n][^*\n]*\*)|(_(?!_)[^_\s\n][^_\n]*_)|(!\[[^\]\n]*\]\([^)\n]*\))|(\[[^\]\n]*\]\([^)\n]*\))/g;

/**
 * Parse one line of inline markdown into styled segments.
 *
 * The base voice is the line's: bright for a heading, normal for prose.
 * Bold raises to bright, code lowers to dim, italic and links keep the
 * base. Text between matches keeps the base. The renderer never invents
 * structure it does not know: an unmatched mark passes through as text.
 */
function inlineSegments(text: string, base: string): MdSpan[] {
	const spans: MdSpan[] = [];
	let cursor = 0;
	for (const match of text.matchAll(INLINE)) {
		const index = match.index ?? 0;
		if (index > cursor) spans.push({ text: text.slice(cursor, index), fg: base });
		const full = match[0];
		if (match[1] !== undefined) {
			// Inline code: dim, the backticks drop.
			spans.push({ text: full.slice(1, -1), fg: "dim" });
		} else if (match[2] !== undefined || match[3] !== undefined || match[4] !== undefined) {
			// Bold: bright. ***triple*** cuts three marks, **double** and
			// __double__ cut two.
			const depth = match[2] === undefined ? 2 : 3;
			spans.push({ text: full.slice(depth, -depth), fg: "bright" });
		} else if (match[5] !== undefined || match[6] !== undefined) {
			// Italic: the line's voice, the mark drops.
			spans.push({ text: full.slice(1, -1), fg: base });
		} else if (match[7] !== undefined) {
			// Image: the alt text stays, the URL and the marks drop.
			spans.push({ text: full.slice(2, full.indexOf("](")), fg: base });
		} else if (match[8] !== undefined) {
			// Link: the label stays, the URL drops.
			spans.push({ text: full.slice(1, full.indexOf("](")), fg: base });
		} else {
			spans.push({ text: full, fg: base });
		}
		cursor = index + full.length;
	}
	if (cursor < text.length) spans.push({ text: text.slice(cursor), fg: base });
	return spans;
}

/** Cut one word to pieces of at most `width` cells, on grapheme boundaries. */
function hardCut(word: string, width: number): string[] {
	if (widthOf(word) <= width) return [word];
	const pieces: string[] = [];
	let current = "";
	for (const grapheme of graphemes(word)) {
		if (widthOf(current) > 0 && widthOf(current + grapheme) > width) {
			pieces.push(current);
			current = grapheme;
		} else {
			current += grapheme;
		}
	}
	if (current !== "") pieces.push(current);
	return pieces;
}

/**
 * Wrap styled segments to `width` cells, on word boundaries.
 *
 * The segments flatten to their words, keeping each word's voice. Multiple
 * spaces between words collapse to one. A word wider than the budget is
 * hard-cut. Every line but the last of the result is exactly `width` cells.
 */
function wrapStyled(segments: readonly MdSpan[], width: number): MdSpan[][] {
	if (width < 1) return [];
	const words: MdSpan[] = [];
	for (const span of segments) {
		for (const part of span.text.replace(/ {2,}/g, " ").split(" ")) {
			if (part !== "") words.push({ text: part, fg: span.fg });
		}
	}
	const lines: MdSpan[][] = [];
	let current: MdSpan[] = [];
	let currentWidth = 0;
	const flush = (): void => {
		if (current.length > 0) {
			lines.push(current);
			current = [];
			currentWidth = 0;
		}
	};
	for (const word of words) {
		for (const piece of hardCut(word.text, width)) {
			const pieceWidth = widthOf(piece);
			if (currentWidth === 0) {
				current.push({ text: piece, fg: word.fg });
				currentWidth = pieceWidth;
				if (currentWidth >= width) flush();
			} else if (currentWidth + 1 + pieceWidth <= width) {
				current.push({ text: " ", fg: word.fg });
				current.push({ text: piece, fg: word.fg });
				currentWidth += 1 + pieceWidth;
			} else {
				flush();
				current.push({ text: piece, fg: word.fg });
				currentWidth = pieceWidth;
				if (currentWidth >= width) flush();
			}
		}
	}
	if (current.length > 0) {
		lines.push(current);
	} else if (lines.length === 0) {
		lines.push([]);
	}
	return lines;
}

/**
 * Render a markdown source into wrapped lines of at most `width` cells.
 *
 * The rules, per line of the source:
 * - A fence of backticks or tildes toggles the code block. The fence lines
 *   drop; the block's lines stay dim and gain two cells of indent on every
 *   row, the wrapped continuations included.
 * - A heading is bright, the "#" marks drop.
 * - A horizontal rule is a blank line.
 * - A block quote keeps its text, the ">" drops.
 * - A list item keeps its marker and indents two cells per level, the level
 *   read from the two-space steps of the source.
 * - Anything else is prose.
 */
export function renderMarkdown(source: string, width: number, colors: MdColors): MdLine[] {
	if (width < 1) return [];
	const out: MdLine[] = [];
	let inCode = false;
	for (const raw of source.split("\n")) {
		const fence = raw.trimStart().match(/^(```+|~~~+)/);
		if (fence !== null) {
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			for (const line of wrapStyled([{ text: raw, fg: "dim" }], width - 2)) {
				out.push(
					line.length === 0
						? [{ text: "  ", fg: "dim" }]
						: [{ text: `  ${line[0].text}`, fg: line[0].fg }, ...line.slice(1)],
				);
			}
			continue;
		}
		const heading = raw.match(/^(#{1,6})\s+(.*)$/);
		if (heading !== null) {
			for (const line of wrapStyled(inlineSegments(heading[2], "bright"), width)) {
				out.push(line);
			}
			continue;
		}
		if (raw.trim() !== "" && /^\s*([-*_])\s*(?:\1\s*){2,}$/.test(raw)) {
			out.push([]);
			continue;
		}
		let text = raw.replace(/^>\s?/, "");
		let indent = 0;
		const item = text.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
		if (item !== null) {
			indent = Math.min(Math.floor(item[1].replace(/\t/g, "  ").length / 2), 3) * 2;
			text = `${item[2]} ${item[3]}`;
		}
		for (const line of wrapStyled(inlineSegments(text, "normal"), width - indent)) {
			if (indent === 0) {
				out.push(line);
			} else {
				out.push(
					line.map((span, index) =>
						index === 0 && span.text !== ""
							? { text: " ".repeat(indent) + span.text, fg: span.fg }
							: span,
					),
				);
			}
		}
	}
	return out.map((line) => line.map((span) => paint(span, colors)));
}

/** Resolve a span's placeholder voice against the palette. */
function paint(span: MdSpan, colors: MdColors): MdSpan {
	const fg = span.fg === "bright" ? colors.bright : span.fg === "dim" ? colors.dim : colors.text;
	return { text: span.text, fg };
}
