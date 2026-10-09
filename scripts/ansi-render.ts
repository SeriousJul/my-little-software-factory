/**
 * The screenshot renderer: one terminal cell per rectangle, the real colors.
 *
 * It reads the ANSI byte stream a PTY session captured from the production
 * renderer and reduces it to the screen the operator sees: a grid of
 * (character, foreground, background, weight) cells. It then paints that
 * grid to a PNG: each cell in its background color, its glyph blended over
 * the background by the per-pixel coverage the screen font rasterizes, and
 * a bold cell on the Bold face. A 24-bit color the stream names is painted
 * exactly; a basic color is painted from the terminal's own sixteen; a cell
 * that names no color is painted with the terminal's own background and
 * foreground. The committed screenshots are the output of this renderer over
 * the captured stream, so an image change is always a screen change.
 *
 * The parser keeps only what the production stream uses: cursor addressing
 * and movement, character attributes (SGR), line endings, and everything
 * else (modes, queries, OSC strings, charset selects) ignored. The screen is
 * the size the session was opened with; a cell outside it is dropped.
 */

import { deflateSync } from "node:zlib";

import { CELL_H, CELL_W, glyphOf } from "./screen-font.ts";

/**
 * The terminal's own colors: the background and foreground a cell falls back
 * to when the stream names none, and the sixteen basic colors SGR 30-37 and
 * 90-97 name. A capture pins these beside its theme in
 * `scripts/screenshot-fixture.ts` (ADR 0123), because a capture reads nothing
 * from the machine it runs on.
 */
export interface TerminalColors {
	/** The terminal's own background. */
	readonly background: readonly [number, number, number];
	/** The terminal's own foreground. */
	readonly foreground: readonly [number, number, number];
	/** The terminal's sixteen basic colors, in SGR order. */
	readonly basic: readonly (readonly [number, number, number])[];
}

/** One cell's color: a basic index, an exact 24-bit triple, or -1 for the terminal's own. */
type CellColor = number | readonly [number, number, number];

/** One cell of the terminal grid. */
interface Cell {
	char: string;
	fg: CellColor;
	bg: CellColor;
	bold: boolean;
}

/**
 * The 240-entry cube and the 24 gray ramp, as the standard xterm-256
 * terminal resolves them: the cube lays out as 16 + 36*r + 6*g + b, each axis
 * step 0 standing at 0 and step n at 55 + 40*n, and the ramp runs from 8 to
 * 238 in steps of 10. The caller passes an index from 16 to 255.
 */
function xterm256(index: number): [number, number, number] {
	if (index < 232) {
		const i = index - 16;
		const cubed = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		return [cubed(Math.floor(i / 36)), cubed(Math.floor((i % 36) / 6)), cubed(i % 6)];
	}
	const gray = (index - 232) * 10 + 8;
	return [gray, gray, gray];
}

/**
 * Reduce an ANSI byte stream to the cell grid of the screen it ends on.
 *
 * `cols` and `rows` are the size the PTY was opened with: the grid the
 * renderer drew into, and the size the screenshot shows.
 */
export function parseScreen(data: Uint8Array, cols: number, rows: number): Cell[][] {
	const state: ScreenState = {
		cells: Array.from({ length: rows }, () =>
			Array.from({ length: cols }, () => ({ char: " ", fg: -1, bg: -1, bold: false })),
		),
		rows,
		cols,
		row: 0,
		col: 0,
		fg: -1,
		bg: -1,
		bold: false,
		text: "",
		decoder: new TextDecoder(),
	};

	let i = 0;
	while (i < data.length) {
		i = screenByteStep(state, data, i, rows);
		if (i === -1) break;
	}
	screenFlush(state);
	return state.cells;
}

/** The index one byte consumes, or -1 to stop the parse. */
function screenByteStep(state: ScreenState, data: Uint8Array, i: number, rows: number): number {
	const byte = data[i];
	if (byte === 0x1b) {
		const next = screenParseEscape(state, data, i);
		if (next === -1) return -1;
		return next;
	}
	if (byte === 0x0d) {
		screenFlush(state);
		state.col = 0;
		return i + 1;
	}
	if (byte === 0x0a) {
		screenFlush(state);
		state.row = Math.min(rows - 1, state.row + 1);
		return i + 1;
	}
	if (byte === 0x08) {
		screenFlush(state);
		state.col = Math.max(0, state.col - 1);
		return i + 1;
	}
	if (byte === 0x07) return i + 1;
	if (byte < 0x20) return i + 1;
	state.text += String.fromCharCode(byte);
	return i + 1;
}

/** The parse's state: the grid, the cursor, the SGR style, the pending text. */
interface ScreenState {
	cells: Cell[][];
	rows: number;
	cols: number;
	row: number;
	col: number;
	fg: CellColor;
	bg: CellColor;
	bold: boolean;
	text: string;
	decoder: TextDecoder;
}

/** One escape at `i`; the index past it, or -1 when the stream ends mid-way. */
function screenParseEscape(state: ScreenState, data: Uint8Array, i: number): number {
	screenFlush(state);
	if (i + 1 >= data.length) return -1;
	const next = data[i + 1];
	if (next === 0x5b) return screenParseCsi(state, data, i + 2);
	if (next === 0x5d) return screenParseOsc(data, i + 2);
	// Other escapes: a two-byte sequence (charset select, etc.).
	return i + 2;
}

/** The index one CSI sequence at `j` consumes, or -1 when the stream ends mid-way. */
function screenParseCsi(state: ScreenState, data: Uint8Array, j: number): number {
	// CSI: parameters up to a final byte 0x40-0x7e.
	let params = "";
	if (data[j] === 0x3f) j += 1; // private marker, never read
	while (j < data.length && (data[j] < 0x40 || data[j] > 0x7e)) {
		params += String.fromCharCode(data[j]);
		j += 1;
	}
	if (j >= data.length) return -1;
	const final = String.fromCharCode(data[j]);
	if (final === "m") {
		if (params !== "") screenSgr(state, params);
	} else if (final === "J" || final === "K") {
		screenErase(state, final, Number(params) || 0);
	} else {
		screenCsiMove(state, final, params);
	}
	return j + 1;
}

/** The index one OSC sequence at `j` consumes. */
function screenParseOsc(data: Uint8Array, j: number): number {
	// OSC: ends at BEL or ST.
	while (j < data.length && data[j] !== 0x07) {
		if (data[j] === 0x1b && j + 1 < data.length && data[j + 1] === 0x5c) {
			j += 1;
			break;
		}
		j += 1;
	}
	return j + 1;
}

/** One SGR sequence against the parse's style. */
function screenSgr(state: ScreenState, params: string): void {
	const p = params.split(";").map((part) => (part === "" ? 0 : Number(part)));
	if (params.trim() === "") return;
	for (let i = 0; i < p.length; i = screenSgrCode(state, p[i], p, i)) {
		// The code lands on the style and names the index it consumed.
	}
}

/** The one color one SGR range code names, and the slot it stands in. */
function screenSgrRange(code: number): { color: number; background: boolean } | undefined {
	if (code >= 30 && code <= 37) return { color: code - 30, background: false };
	if (code >= 40 && code <= 47) return { color: code - 40, background: true };
	if (code >= 90 && code <= 97) return { color: code - 90 + 8, background: false };
	if (code >= 100 && code <= 107) return { color: code - 100 + 8, background: true };
	return undefined;
}

/** The index one extended SGR code consumes, after it lands on the parse's style. */
function screenExtendedStep(
	state: ScreenState,
	code: number,
	p: number[],
	i: number,
): number | undefined {
	const extended = screenExtendedColor(p, i);
	if (extended === null) return undefined;
	if (code === 38) state.fg = extended.color;
	else state.bg = extended.color;
	return extended.next;
}

/** The index one SGR code consumes, after it lands on the parse's style. */
function screenSgrCode(state: ScreenState, code: number, p: number[], i: number): number {
	if (code === 0) {
		state.fg = -1;
		state.bg = -1;
		state.bold = false;
		return i + 1;
	}
	if (code === 1) {
		state.bold = true;
		return i + 1;
	}
	if (code === 22) {
		state.bold = false;
		return i + 1;
	}
	if (code === 39) {
		state.fg = -1;
		return i + 1;
	}
	if (code === 49) {
		state.bg = -1;
		return i + 1;
	}
	if (code === 38 || code === 48) {
		const extended = screenExtendedStep(state, code, p, i);
		if (extended !== undefined) return extended;
	}
	const range = screenSgrRange(code);
	if (range !== undefined) {
		if (range.background) state.bg = range.color;
		else state.fg = range.color;
	}
	return i + 1;
}

/**
 * One extended SGR color: `38`/`48`, a mode, and the values.
 * Returns the color and the index past the sequence, or null when the
 * parameters name no color.
 */
function screenExtendedColor(p: number[], i: number): { color: CellColor; next: number } | null {
	if (p[i + 1] === 5 && Number.isFinite(p[i + 2])) {
		return { color: screenColorOf256(p[i + 2]), next: i + 3 };
	}
	if (p[i + 1] === 2) {
		return { color: [p[i + 2] ?? 0, p[i + 3] ?? 0, p[i + 4] ?? 0], next: i + 5 };
	}
	return null;
}

/**
 * One 256-color index, as the terminal resolves it: a basic index, or the
 * exact RGB of the cube or ramp. An index no terminal names - a broken
 * stream past 255, or a negative one - falls back to black.
 */
function screenColorOf256(index: number): CellColor {
	if (index < 0 || index > 255) return [0, 0, 0];
	return index < 16 ? index : xterm256(index);
}

/** The cursor-moving CSI finals: H, f, A, B, C, D, E, F, G, and d. */
function screenCsiMove(state: ScreenState, final: string, params: string): void {
	if (final === "H" || final === "f") {
		csiHome(state, params);
		return;
	}
	if (final === "A") {
		csiRowStep(state, -1, params);
		return;
	}
	if (final === "B" || final === "e") {
		csiRowStep(state, 1, params);
		return;
	}
	if (final === "C" || final === "a") {
		csiColStep(state, 1, params);
		return;
	}
	if (final === "D") {
		csiColStep(state, -1, params);
		return;
	}
	if (final === "E") {
		csiRowStep(state, 1, params);
		state.col = 0;
		return;
	}
	if (final === "F") {
		csiRowStep(state, -1, params);
		state.col = 0;
		return;
	}
	if (final === "G" || final === "`") {
		csiColSet(state, params);
		return;
	}
	if (final === "d") csiRowSet(state, params);
}

/** The cursor's home move: the row and column the parameters name. */
function csiHome(state: ScreenState, params: string): void {
	const [r = "1", c = "1"] = (params === "" ? "" : params).split(";");
	state.row = Number(r) - 1;
	state.col = Number(c) - 1;
}

/** The row step: one row up or down, by the count the parameters name. */
function csiRowStep(state: ScreenState, direction: 1 | -1, params: string): void {
	const n = Number(params) || 1;
	if (direction === -1) state.row = Math.max(0, state.row - n);
	else state.row = Math.min(state.rows - 1, state.row + n);
}

/** The column step: one column left or right, by the count the parameters name. */
function csiColStep(state: ScreenState, direction: 1 | -1, params: string): void {
	const n = Number(params) || 1;
	if (direction === -1) state.col = Math.max(0, state.col - n);
	else state.col = Math.min(state.cols - 1, state.col + n);
}

/** The row set: the row the parameters name, clamped to the grid. */
function csiRowSet(state: ScreenState, params: string): void {
	state.row = Math.max(0, Number(params) - 1);
}

/** The column set: the column the parameters name, clamped to the grid. */
function csiColSet(state: ScreenState, params: string): void {
	state.col = Math.max(0, Number(params) - 1);
}

/** The grid-erasing CSI finals: J the screen, K the line. */
function screenErase(state: ScreenState, final: string, which: number): void {
	const blankCell: Cell = { char: " ", fg: -1, bg: -1, bold: false };
	if (final === "J") {
		eraseScreen(state, which, blankCell);
	} else {
		eraseLine(state, which, blankCell);
	}
}

/** The rows one J erase blanks, for the mode it wears. */
function eraseScreen(state: ScreenState, which: number, blankCell: Cell): void {
	for (let r = 0; r < state.rows; r++)
		for (let c = 0; c < state.cols; c++) {
			if (jCellInCursor(state, which, r, c)) state.cells[r][c] = { ...blankCell };
		}
}

/** Whether the cell at (r, c) is inside the region the J mode names. */
function jCellInCursor(state: ScreenState, which: number, r: number, c: number): boolean {
	if (which === 0) return (r === state.row && c <= state.col) || r < state.row;
	if (which === 1) return (r === state.row && c >= state.col) || r > state.row;
	return true;
}

/** The row one K erase blanks, for the mode it wears. */
function eraseLine(state: ScreenState, which: number, blankCell: Cell): void {
	for (let c = 0; c < state.cols; c++) {
		const inCursor = which === 0 ? c >= state.col : which === 1 ? c <= state.col : true;
		if (inCursor) state.cells[state.row][c] = { ...blankCell };
	}
}

/** One cell, at the cursor, wrapping to the row below at the grid's edge. */
function screenEmit(state: ScreenState, ch: string): void {
	if (state.row < 0 || state.row >= state.rows || state.col < 0 || state.col >= state.cols) return;
	state.cells[state.row][state.col] = { char: ch, fg: state.fg, bg: state.bg, bold: state.bold };
	state.col += 1;
	if (state.col >= state.cols) {
		state.col = 0;
		state.row += 1;
	}
}

/** Finish the pending plain-text run and reset the SGR state for a CSI. */
function screenFlush(state: ScreenState): void {
	for (const ch of state.decoder.decode(
		state.text ? Buffer.from(state.text, "latin1") : new Uint8Array(),
	)) {
		screenEmit(state, ch);
	}
	state.text = "";
}

/**
 * Paint a cell grid to a PNG.
 *
 * One cell per font cell: the background fills the cell, and the glyph's
 * coverage blends the foreground over it, pixel by pixel. A -1 names the
 * terminal's own color: the background for a cell the stream gives none, the
 * foreground for a cell the stream gives none. A basic index stands in the
 * terminal's own sixteen, and an exact triple paints as the stream named it.
 */
export function renderPng(cells: Cell[][], colors: TerminalColors): Buffer {
	const cols = cells[0]?.length ?? 0;
	const rows = cells.length;
	const width = cols * CELL_W;
	const height = rows * CELL_H;
	const pixels = Buffer.alloc(width * height * 3);
	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const cell = cells[r][c];
			const cellBg = resolveColor(cell.bg, colors.background, colors);
			const cellFg = resolveColor(cell.fg, colors.foreground, colors);
			const x0 = c * CELL_W;
			const y0 = r * CELL_H;
			// The rectangle.
			paintCellBackground(pixels, x0, y0, { width, bg: cellBg });
			const glyph = glyphOf(cell.char, cell.bold);
			if (glyph === undefined) continue;
			paintCellGlyph(pixels, x0, y0, { width, glyph, bg: cellBg, fg: cellFg });
		}
	}
	return encodePng(pixels, width, height);
}

/** The color one cell's value resolves to, or the fallback it takes. */
function resolveColor(
	value: CellColor,
	fallback: readonly [number, number, number],
	colors: TerminalColors,
): readonly [number, number, number] {
	return value === -1 ? fallback : typeof value === "number" ? colors.basic[value] : value;
}

/** The rectangle one cell's background fills. */
function paintCellBackground(
	pixels: Buffer,
	x0: number,
	y0: number,
	fields: { width: number; bg: readonly [number, number, number] },
): void {
	const { width, bg } = fields;
	for (let y = 0; y < CELL_H; y++) {
		const rowStart = ((y0 + y) * width + x0) * 3;
		for (let x = 0; x < CELL_W; x++) {
			const off = rowStart + x * 3;
			pixels[off] = bg[0];
			pixels[off + 1] = bg[1];
			pixels[off + 2] = bg[2];
		}
	}
}

/** The glyph one cell's character paints over its background. */
function paintCellGlyph(
	pixels: Buffer,
	x0: number,
	y0: number,
	fields: {
		width: number;
		glyph: Uint8Array;
		bg: readonly [number, number, number];
		fg: readonly [number, number, number];
	},
): void {
	const { width, glyph, bg, fg } = fields;
	for (let y = 0; y < CELL_H; y++) {
		for (let x = 0; x < CELL_W; x++) {
			const coverage = glyph[y * CELL_W + x] / 255;
			if (coverage === 0) continue;
			const off = ((y0 + y) * width + x0 + x) * 3;
			pixels[off] = Math.round(bg[0] * (1 - coverage) + fg[0] * coverage);
			pixels[off + 1] = Math.round(bg[1] * (1 - coverage) + fg[1] * coverage);
			pixels[off + 2] = Math.round(bg[2] * (1 - coverage) + fg[2] * coverage);
		}
	}
}

// --- A minimal PNG encoder: one IDAT of raw filter-0 scanlines. ---

const CRC_TABLE: number[] = (() => {
	const table: number[] = [];
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table.push(c >>> 0);
	}
	return table;
})();

function crc32(buffer: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(payload.length);
	const typeBuffer = Buffer.from(type, "ascii");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, payload])));
	return Buffer.concat([length, typeBuffer, payload, crc]);
}

function encodePng(pixels: Buffer, width: number, height: number): Buffer {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor
	const raw = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y++) {
		raw[y * (1 + width * 3)] = 0; // filter: none
		pixels.copy(raw, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
	}
	return Buffer.concat([
		signature,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", deflateSync(raw, { level: 9 })),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}
