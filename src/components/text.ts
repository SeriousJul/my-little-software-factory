/**
 * Terminal text helpers.
 *
 * Terminal layout is measured in cells, not JavaScript string length: CJK
 * characters and emoji occupy two cells, combining marks occupy zero. Every
 * clip, pad, and wrap in the panes goes through these helpers so rows keep
 * their exact cell width at any terminal size and for any ticket text.
 */
import stringWidth from "string-width";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Split a string into grapheme clusters, the safest unit to cut on. */
function graphemes(text: string): string[] {
	return Array.from(segmenter.segment(text), (part) => part.segment);
}

/** The width of a string in terminal cells. */
export function widthOf(text: string): number {
	return stringWidth(text);
}

/**
 * Shorten a string to at most `width` cells.
 *
 * Cuts only on grapheme boundaries, so emoji and CJK never split in the
 * middle. Widths below one cell yield "".
 */
export function truncateToWidth(text: string, width: number): string {
	if (width < 1) {
		return "";
	}
	if (widthOf(text) <= width) {
		return text;
	}
	let out = "";
	let used = 0;
	for (const grapheme of graphemes(text)) {
		const graphemeWidth = widthOf(grapheme);
		if (used + graphemeWidth > width) {
			break;
		}
		out += grapheme;
		used += graphemeWidth;
	}
	return out;
}

/**
 * Shorten a string to at most `width` cells, and say that it was cut.
 *
 * A cut that leaves no mark reads as a whole line, so the operator cannot
 * tell a fact from the first half of it. The ellipsis takes the last cell of
 * the budget, so the result still fits `width`. Widths too small to hold both
 * a cell of text and the mark fall back to a plain cut.
 */
export function truncateWithEllipsis(text: string, width: number): string {
	if (widthOf(text) <= width || width < 2) {
		return truncateToWidth(text, width);
	}
	return `${truncateToWidth(text, width - 1)}\u2026`;
}

/** Pad a string with trailing spaces to exactly `width` cells. */
export function padToWidth(text: string, width: number): string {
	const w = widthOf(text);
	if (w >= width) {
		return text;
	}
	return `${text}${" ".repeat(width - w)}`;
}

/**
 * Wrap words to at most `width` cells.
 *
 * A single word wider than the budget is cut hard on grapheme boundaries.
 * Widths below one cell yield no lines.
 */
export function wrapToWidth(text: string, width: number): string[] {
	if (width < 1) {
		return [];
	}
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(" ")) {
		for (const piece of hardWrap(word, width)) {
			if (current === "") {
				current = piece;
			} else if (widthOf(current) + 1 + widthOf(piece) <= width) {
				current = `${current} ${piece}`;
			} else {
				lines.push(current);
				current = piece;
			}
		}
	}
	if (current !== "") {
		lines.push(current);
	}
	return lines;
}

/** Cut one word to lines of at most `width` cells, on grapheme boundaries. */
function hardWrap(word: string, width: number): string[] {
	if (word === "") {
		return [];
	}
	const pieces: string[] = [];
	let current = "";
	for (const grapheme of graphemes(word)) {
		if (current !== "" && widthOf(current) + widthOf(grapheme) > width) {
			pieces.push(current);
			current = grapheme;
		} else {
			current += grapheme;
		}
	}
	if (current !== "") {
		pieces.push(current);
	}
	return pieces;
}
