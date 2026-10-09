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
/**
 * Interpret only terminal display controls. Escape sequences never reach the
 * renderer, so a pane cannot alter the control plane terminal outside this
 * bounded cell grid.
 */
export function renderAnsiScreen(input: string, width: number, maxRows = 512): AnsiLine[] {
	const state: AnsiScreenState = {
		rows: [[]],
		columns: Math.max(1, width),
		maxRows,
		x: 0,
		y: 0,
		style: { ...DEFAULT_STYLE },
	};
	for (let index = 0; index < input.length; ) {
		const code = input.codePointAt(index) as number;
		const character = String.fromCodePoint(code);
		index += character.length;
		if (character === "\u001b") {
			index = escapeStep(input, index, state);
			if (index === -1) break;
			continue;
		}
		plainCharacterStep(state, character);
	}
	return state.rows.map((row) => cellsToSpans(row, state.columns));
}

/** The one cell one ordinary character places on the screen. */
function plainCharacterStep(state: AnsiScreenState, character: string): void {
	if (character === "\n") {
		state.x = 0;
		state.y = Math.min(state.maxRows - 1, state.y + 1);
		ansiEnsureRow(state, state.y);
	} else if (character === "\r") state.x = 0;
	else if (character === "\b") state.x = Math.max(0, state.x - 1);
	else if (character === "\t") state.x = Math.min(state.columns - 1, state.x + (8 - (state.x % 8)));
	else if (!/\p{Cc}/u.test(character)) ansiWrite(state, character);
}

/** The screen state's index after one escape character's sequence, or -1 to stop. */
function escapeStep(input: string, index: number, state: AnsiScreenState): number {
	if (input[index] === "[") {
		const end = findCsiEnd(input, index + 1);
		if (end === -1) return -1;
		const params = input.slice(index + 1, end);
		const command = input[end];
		applyCsiCommand(state, command, parseCsiValues(params));
		return end + 1;
	}
	if (input[index] === "]") return skipOsc(input, index + 1);
	return index + 1;
}

/** The screen's state: the cell grid, the cursor, the running style. */
interface AnsiScreenState {
	rows: Cell[][];
	columns: number;
	maxRows: number;
	x: number;
	y: number;
	style: AnsiStyle;
}

/** The CSI's parameter list, parsed to the command's values. */
function parseCsiValues(params: string): number[] {
	return params
		.replace(/^[?>!]/, "")
		.split(";")
		.map((value) => (value === "" ? 0 : Number(value)))
		.map((value) => (Number.isFinite(value) ? value : 0));
}

/** One CSI command against the screen's state. */
function applyCsiCommand(state: AnsiScreenState, command: string, values: number[]): void {
	const count = Math.max(1, values[0] ?? 0);
	switch (command) {
		case "m":
			state.style = applySgr(state.style, values);
			break;
		case "H":
		case "f":
			state.y = Math.min(state.maxRows - 1, Math.max(0, (values[0] || 1) - 1));
			state.x = Math.min(state.columns - 1, Math.max(0, (values[1] || 1) - 1));
			ansiEnsureRow(state, state.y);
			break;
		case "A":
			state.y = Math.max(0, state.y - count);
			break;
		case "B":
			state.y = Math.min(state.maxRows - 1, state.y + count);
			ansiEnsureRow(state, state.y);
			break;
		case "C":
			state.x = Math.min(state.columns - 1, state.x + count);
			break;
		case "D":
			state.x = Math.max(0, state.x - count);
			break;
		case "G":
			state.x = Math.min(state.columns - 1, Math.max(0, count - 1));
			break;
		case "J":
			ansiEraseScreen(state, values[0] ?? 0);
			break;
		case "K":
			ansiEraseLine(state, values[0] ?? 0);
			break;
	}
}

/** Grow the grid to the row, and hand it back. */
function ansiEnsureRow(state: AnsiScreenState, row: number): Cell[] {
	while (state.rows.length <= row && state.rows.length < state.maxRows) state.rows.push([]);
	return state.rows[Math.min(row, state.maxRows - 1)];
}

/** One line's erase: EL 0 the cursor to end, EL 1 the start to cursor, EL 2 all. */
function ansiEraseLine(state: AnsiScreenState, mode: number): void {
	const row = ansiEnsureRow(state, state.y);
	// EL 0: cursor to end. EL 1: start to cursor. EL 2: the whole line.
	const start = mode === 0 ? state.x : 0;
	const end = mode === 1 ? state.x : state.columns;
	for (let index = start; index < end; index += 1) row[index] = blank(state.style);
}

/** The screen's erase: ED 2 and ED 3 reset the grid, ED 0 clears down. */
function ansiEraseScreen(state: AnsiScreenState, mode: number): void {
	if (mode === 2 || mode === 3) {
		state.rows.splice(0, state.rows.length, []);
		state.x = 0;
		state.y = 0;
		return;
	}
	for (let row = state.y; row < state.rows.length; row += 1) {
		const cells = ansiEnsureRow(state, row);
		const start = row === state.y ? state.x : 0;
		for (let column = start; column < state.columns; column += 1)
			cells[column] = blank(state.style);
	}
}

/** Write printable text to the grid, wrapping at the grid's edge. */
function ansiWrite(state: AnsiScreenState, text: string): void {
	for (const character of text) {
		const cellWidth = Math.max(0, widthOf(character));
		if (cellWidth === 0) {
			const row = ansiEnsureRow(state, state.y);
			const previous = row[Math.max(0, state.x - 1)];
			if (previous !== undefined) previous.text += character;
			continue;
		}
		if (state.x + cellWidth > state.columns) {
			state.x = 0;
			state.y = Math.min(state.maxRows - 1, state.y + 1);
		}
		const row = ansiEnsureRow(state, state.y);
		row[state.x] = { text: character, style: { ...state.style } };
		if (cellWidth === 2 && state.x + 1 < state.columns)
			row[state.x + 1] = { text: "", style: { ...state.style }, continuation: true };
		state.x = Math.min(state.columns, state.x + cellWidth);
	}
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

/** The style's attribute flags, while the values land. */
interface SgrFlags {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	strikethrough: boolean;
}

/** The style's draft: the colors and the attribute flags, while the values land. */
interface SgrDraft {
	fg: string | undefined;
	bg: string | undefined;
	flags: SgrFlags;
}

/** The one attribute one simple SGR value sets, with the on or off it wears. */
const SGR_SINGLETONS: Array<[number, keyof SgrFlags, boolean]> = [
	[1, "bold", true],
	[2, "dim", true],
	[3, "italic", true],
	[4, "underline", true],
	[7, "inverse", true],
	[9, "strikethrough", true],
	[23, "italic", false],
	[24, "underline", false],
	[27, "inverse", false],
	[29, "strikethrough", false],
];

/** The one color one SGR range code names, and the slot it stands in. */
function sgrRangeColor(value: number): { color: string; background: boolean } | undefined {
	if (value >= 30 && value <= 37) return { color: ANSI_COLORS[value - 30], background: false };
	if (value >= 40 && value <= 47) return { color: ANSI_COLORS[value - 40], background: true };
	if (value >= 90 && value <= 97)
		return { color: ANSI_BRIGHT_COLORS[value - 90], background: false };
	if (value >= 100 && value <= 107)
		return { color: ANSI_BRIGHT_COLORS[value - 100], background: true };
	return undefined;
}

/** The index one extended SGR color passes to, after it lands on the draft. */
function sgrExtendedStep(
	draft: SgrDraft,
	value: number,
	values: number[],
	index: number,
): number | undefined {
	const color = sgrExtendedColor(values, index + 1);
	if (color === undefined) return undefined;
	if (value === 38) draft.fg = color.value;
	else draft.bg = color.value;
	return color.last + 1;
}

/** The index one SGR value consumes, after it lands on the draft. */
function sgrValueStep(draft: SgrDraft, values: number[], index: number): number {
	const value = values[index] ?? 0;
	if (value === 0) {
		draft.fg = undefined;
		draft.bg = undefined;
		draft.flags.bold =
			draft.flags.dim =
			draft.flags.italic =
			draft.flags.underline =
			draft.flags.inverse =
			draft.flags.strikethrough =
				false;
		return index + 1;
	}
	if (value === 22) {
		draft.flags.bold = false;
		draft.flags.dim = false;
		return index + 1;
	}
	if (value === 39) {
		draft.fg = undefined;
		return index + 1;
	}
	if (value === 49) {
		draft.bg = undefined;
		return index + 1;
	}
	if (value === 38 || value === 48) {
		const last = sgrExtendedStep(draft, value, values, index);
		if (last !== undefined) return last;
	}
	const singleton = SGR_SINGLETONS.find(([code]) => code === value);
	if (singleton !== undefined) draft.flags[singleton[1]] = singleton[2];
	const range = sgrRangeColor(value);
	if (range !== undefined) {
		if (range.background) draft.bg = range.color;
		else draft.fg = range.color;
	}
	return index + 1;
}

function applySgr(current: AnsiStyle, values: number[]): AnsiStyle {
	const draft: SgrDraft = {
		fg: current.fg,
		bg: current.bg,
		flags: {
			bold: false,
			dim: false,
			italic: false,
			underline: false,
			inverse: false,
			strikethrough: false,
		},
	};
	for (let index = 0; index < values.length; index = sgrValueStep(draft, values, index)) {
		// The step lands the value on the draft and names the index it consumed.
	}
	return {
		fg: draft.fg,
		bg: draft.bg,
		attributes: createTextAttributes(draft.flags),
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
