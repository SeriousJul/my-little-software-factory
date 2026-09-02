/** A bounded, side-effect-free ANSI terminal cell renderer. */
import { createTextAttributes } from "@opentui/core";

import { widthOf } from "./text.ts";

export interface AnsiStyle {
	fg?: string;
	bg?: string;
	attributes: number;
}

export interface AnsiSpan {
	text: string;
	style: AnsiStyle;
}

export type AnsiLine = AnsiSpan[];

interface Cell {
	text: string;
	style: AnsiStyle;
	continuation?: boolean;
}

const DEFAULT_STYLE: AnsiStyle = { attributes: 0 };
const ANSI_COLORS = [
	"#000000",
	"#cd3131",
	"#0dbc79",
	"#e5e510",
	"#2472c8",
	"#bc3fbc",
	"#11a8cd",
	"#e5e5e5",
] as const;
const ANSI_BRIGHT_COLORS = [
	"#666666",
	"#f14c4c",
	"#23d18b",
	"#f5f543",
	"#3b8eea",
	"#d670d6",
	"#29b8db",
	"#ffffff",
] as const;

/**
 * Interpret only terminal display controls. Escape sequences never reach the
 * renderer, so a pane cannot alter the control plane terminal outside this
 * bounded cell grid.
 */
export function renderAnsiScreen(input: string, width: number, maxRows = 512): AnsiLine[] {
	const columns = Math.max(1, width);
	const rows: Cell[][] = [[]];
	let x = 0;
	let y = 0;
	let style = { ...DEFAULT_STYLE };
	const ensureRow = (row: number) => {
		while (rows.length <= row && rows.length < maxRows) rows.push([]);
		return rows[Math.min(row, maxRows - 1)];
	};
	const eraseLine = (mode: number) => {
		const row = ensureRow(y);
		// EL 0: cursor to end. EL 1: start to cursor. EL 2: the whole line.
		const start = mode === 0 ? x : 0;
		const end = mode === 1 ? x : columns;
		for (let index = start; index < end; index += 1) row[index] = blank(style);
	};
	const eraseScreen = (mode: number) => {
		if (mode === 2 || mode === 3) {
			rows.splice(0, rows.length, []);
			x = 0;
			y = 0;
			return;
		}
		for (let row = y; row < rows.length; row += 1) {
			const cells = ensureRow(row);
			const start = row === y ? x : 0;
			for (let column = start; column < columns; column += 1) cells[column] = blank(style);
		}
	};
	const write = (text: string) => {
		for (const character of text) {
			const cellWidth = Math.max(0, widthOf(character));
			if (cellWidth === 0) {
				const row = ensureRow(y);
				const previous = row[Math.max(0, x - 1)];
				if (previous !== undefined) previous.text += character;
				continue;
			}
			if (x + cellWidth > columns) {
				x = 0;
				y = Math.min(maxRows - 1, y + 1);
			}
			const row = ensureRow(y);
			row[x] = { text: character, style: { ...style } };
			if (cellWidth === 2 && x + 1 < columns)
				row[x + 1] = { text: "", style: { ...style }, continuation: true };
			x = Math.min(columns, x + cellWidth);
		}
	};
	for (let index = 0; index < input.length; ) {
		const code = input.codePointAt(index) as number;
		const character = String.fromCodePoint(code);
		index += character.length;
		if (character === "\u001b") {
			if (input[index] === "[") {
				const end = findCsiEnd(input, index + 1);
				if (end === -1) break;
				const params = input.slice(index + 1, end);
				const command = input[end];
				index = end + 1;
				const values = params
					.replace(/^[?>!]/, "")
					.split(";")
					.map((value) => (value === "" ? 0 : Number(value)))
					.map((value) => (Number.isFinite(value) ? value : 0));
				const count = Math.max(1, values[0] ?? 0);
				switch (command) {
					case "m":
						style = applySgr(style, values);
						break;
					case "H":
					case "f":
						y = Math.min(maxRows - 1, Math.max(0, (values[0] || 1) - 1));
						x = Math.min(columns - 1, Math.max(0, (values[1] || 1) - 1));
						ensureRow(y);
						break;
					case "A":
						y = Math.max(0, y - count);
						break;
					case "B":
						y = Math.min(maxRows - 1, y + count);
						ensureRow(y);
						break;
					case "C":
						x = Math.min(columns - 1, x + count);
						break;
					case "D":
						x = Math.max(0, x - count);
						break;
					case "G":
						x = Math.min(columns - 1, Math.max(0, count - 1));
						break;
					case "J":
						eraseScreen(values[0] ?? 0);
						break;
					case "K":
						eraseLine(values[0] ?? 0);
						break;
				}
				continue;
			}
			if (input[index] === "]") {
				index = skipOsc(input, index + 1);
				continue;
			}
			index += 1;
			continue;
		}
		if (character === "\n") {
			x = 0;
			y = Math.min(maxRows - 1, y + 1);
			ensureRow(y);
		} else if (character === "\r") x = 0;
		else if (character === "\b") x = Math.max(0, x - 1);
		else if (character === "\t") x = Math.min(columns - 1, x + (8 - (x % 8)));
		else if (!/\p{Cc}/u.test(character)) write(character);
	}
	return rows.map((row) => cellsToSpans(row, columns));
}

function blank(style: AnsiStyle): Cell {
	return { text: " ", style: { ...style } };
}

function findCsiEnd(input: string, from: number): number {
	for (let index = from; index < input.length; index += 1) {
		const code = input.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index;
	}
	return -1;
}

function skipOsc(input: string, from: number): number {
	for (let index = from; index < input.length; index += 1) {
		if (input[index] === "\u0007") return index + 1;
		if (input[index] === "\u001b" && input[index + 1] === "\\") return index + 2;
	}
	return input.length;
}

function applySgr(current: AnsiStyle, values: number[]): AnsiStyle {
	let fg = current.fg;
	let bg = current.bg;
	let bold = false;
	let dim = false;
	let italic = false;
	let underline = false;
	let inverse = false;
	let strikethrough = false;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index] ?? 0;
		if (value === 0) {
			fg = undefined;
			bg = undefined;
			bold = dim = italic = underline = inverse = strikethrough = false;
		} else if (value === 1) bold = true;
		else if (value === 2) dim = true;
		else if (value === 3) italic = true;
		else if (value === 4) underline = true;
		else if (value === 7) inverse = true;
		else if (value === 9) strikethrough = true;
		else if (value === 22) bold = dim = false;
		else if (value === 23) italic = false;
		else if (value === 24) underline = false;
		else if (value === 27) inverse = false;
		else if (value === 29) strikethrough = false;
		else if (value === 39) fg = undefined;
		else if (value === 49) bg = undefined;
		else if (value >= 30 && value <= 37) fg = ANSI_COLORS[value - 30];
		else if (value >= 90 && value <= 97) fg = ANSI_BRIGHT_COLORS[value - 90];
		else if (value >= 40 && value <= 47) bg = ANSI_COLORS[value - 40];
		else if (value >= 100 && value <= 107) bg = ANSI_BRIGHT_COLORS[value - 100];
		else if (value === 38 || value === 48) {
			const color = sgrExtendedColor(values, index + 1);
			if (color !== undefined) {
				if (value === 38) fg = color.value;
				else bg = color.value;
				index = color.last;
			}
		}
	}
	return {
		fg,
		bg,
		attributes: createTextAttributes({ bold, dim, italic, underline, inverse, strikethrough }),
	};
}

function sgrExtendedColor(
	values: number[],
	from: number,
): { value: string; last: number } | undefined {
	if (values[from] === 5 && values[from + 1] !== undefined)
		return { value: ansi256(values[from + 1]), last: from + 1 };
	if (values[from] === 2 && values[from + 3] !== undefined)
		return {
			value: `#${[values[from + 1], values[from + 2], values[from + 3]]
				.map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0"))
				.join("")}`,
			last: from + 3,
		};
	return undefined;
}

function ansi256(value: number): string {
	if (value < 8) return ANSI_COLORS[Math.max(0, value)];
	if (value < 16) return ANSI_BRIGHT_COLORS[value - 8];
	if (value >= 232) {
		const shade = (8 + (value - 232) * 10).toString(16).padStart(2, "0");
		return `#${shade}${shade}${shade}`;
	}
	const index = Math.max(16, Math.min(231, value)) - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	const red = levels[Math.floor(index / 36)];
	const green = levels[Math.floor((index % 36) / 6)];
	const blue = levels[index % 6];
	return `#${[red, green, blue].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function cellsToSpans(cells: Cell[], width: number): AnsiSpan[] {
	const spans: AnsiSpan[] = [];
	let text = "";
	let style: AnsiStyle | undefined;
	const append = (next: string, nextStyle: AnsiStyle) => {
		if (style !== undefined && sameStyle(style, nextStyle)) text += next;
		else {
			if (style !== undefined) spans.push({ text, style });
			text = next;
			style = nextStyle;
		}
	};
	for (let column = 0; column < width; column += 1) {
		const cell = cells[column] ?? blank(DEFAULT_STYLE);
		if (!cell.continuation) append(cell.text, cell.style);
	}
	if (style !== undefined) spans.push({ text, style });
	return spans;
}

function sameStyle(left: AnsiStyle, right: AnsiStyle): boolean {
	return left.fg === right.fg && left.bg === right.bg && left.attributes === right.attributes;
}
