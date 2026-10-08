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
		const byte = data[i];
		if (byte === 0x1b) {
			const next = screenParseEscape(state, data, i);
			if (next === -1) break;
			i = next;
			continue;
		}
		if (byte === 0x0d) {
			screenFlush(state);
			state.col = 0;
			i += 1;
			continue;
		}
		if (byte === 0x0a) {
			screenFlush(state);
			state.row = Math.min(rows - 1, state.row + 1);
			i += 1;
			continue;
		}
		if (byte === 0x08) {
			screenFlush(state);
			state.col = Math.max(0, state.col - 1);
			i += 1;
			continue;
		}
		if (byte === 0x07) {
			i += 1;
			continue;
		}
		if (byte < 0x20) {
			i += 1;
			continue;
		}
		state.text += String.fromCharCode(byte);
		i += 1;
	}
	screenFlush(state);
	return state.cells;
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
	if (next === 0x5b) {
		// CSI: parameters up to a final byte 0x40-0x7e.
		let j = i + 2;
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
	if (next === 0x5d) {
		// OSC: ends at BEL or ST.
		let j = i + 2;
		while (j < data.length && data[j] !== 0x07) {
			if (data[j] === 0x1b && j + 1 < data.length && data[j + 1] === 0x5c) {
				j += 1;
				break;
			}
			j += 1;
		}
		return j + 1;
	}
	// Other escapes: a two-byte sequence (charset select, etc.).
	return i + 2;
}

/** One SGR sequence against the parse's style. */
function screenSgr(state: ScreenState, params: string): void {
	const p = params.split(";").map((part) => (part === "" ? 0 : Number(part)));
	if (params.trim() === "") return;
	for (let i = 0; i < p.length; i++) {
		const code = p[i];
		if (code === 0) {
			state.fg = -1;
			state.bg = -1;
			state.bold = false;
		} else if (code === 1) {
			state.bold = true;
		} else if (code === 22) {
			state.bold = false;
		} else if (code === 39) {
			state.fg = -1;
		} else if (code === 49) {
			state.bg = -1;
		} else if (code >= 30 && code <= 37) {
			state.fg = code - 30;
		} else if (code >= 90 && code <= 97) {
			state.fg = code - 90 + 8;
		} else if (code >= 40 && code <= 47) {
			state.bg = code - 40;
		} else if (code >= 100 && code <= 107) {
			state.bg = code - 100 + 8;
		} else if (code === 38 || code === 48) {
			const extended = screenExtendedColor(p, i);
			if (extended !== null) {
				if (code === 38) state.fg = extended.color;
				else state.bg = extended.color;
				i = extended.next - 1;
			}
		}
	}
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
		const [r = "1", c = "1"] = (params === "" ? "" : params).split(";");
		state.row = Number(r) - 1;
		state.col = Number(c) - 1;
	} else if (final === "A") {
		state.row = Math.max(0, state.row - (Number(params) || 1));
	} else if (final === "B" || final === "e") {
		state.row = Math.min(state.rows - 1, state.row + (Number(params) || 1));
	} else if (final === "C" || final === "a") {
		state.col = Math.min(state.cols - 1, state.col + (Number(params) || 1));
	} else if (final === "D") {
		state.col = Math.max(0, state.col - (Number(params) || 1));
	} else if (final === "E") {
		state.row = Math.min(state.rows - 1, state.row + (Number(params) || 1));
		state.col = 0;
	} else if (final === "F") {
		state.row = Math.max(0, state.row - (Number(params) || 1));
		state.col = 0;
	} else if (final === "G" || final === "`") {
		state.col = Math.max(0, Number(params) - 1);
	} else if (final === "d") {
		state.row = Math.max(0, Number(params) - 1);
	}
}

/** The grid-erasing CSI finals: J the screen, K the line. */
function screenErase(state: ScreenState, final: string, which: number): void {
	const blankCell: Cell = { char: " ", fg: -1, bg: -1, bold: false };
	if (final === "J") {
		for (let r = 0; r < state.rows; r++)
			for (let c = 0; c < state.cols; c++) {
				const inCursor =
					which === 0
						? (r === state.row && c <= state.col) || r < state.row
						: which === 1
							? (r === state.row && c >= state.col) || r > state.row
							: true;
				if (inCursor) state.cells[r][c] = { ...blankCell };
			}
	} else {
		for (let c = 0; c < state.cols; c++) {
			const inCursor = which === 0 ? c >= state.col : which === 1 ? c <= state.col : true;
			if (inCursor) state.cells[state.row][c] = { ...blankCell };
		}
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
	const resolve = (
		value: CellColor,
		fallback: readonly [number, number, number],
	): readonly [number, number, number] =>
		value === -1 ? fallback : typeof value === "number" ? colors.basic[value] : value;

	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const cell = cells[r][c];
			const cellBg = resolve(cell.bg, colors.background);
			const cellFg = resolve(cell.fg, colors.foreground);
			const x0 = c * CELL_W;
			const y0 = r * CELL_H;
			// The rectangle.
			for (let y = 0; y < CELL_H; y++) {
				const rowStart = ((y0 + y) * width + x0) * 3;
				for (let x = 0; x < CELL_W; x++) {
					const off = rowStart + x * 3;
					pixels[off] = cellBg[0];
					pixels[off + 1] = cellBg[1];
					pixels[off + 2] = cellBg[2];
				}
			}
			const glyph = glyphOf(cell.char, cell.bold);
			if (glyph === undefined) continue;
			for (let y = 0; y < CELL_H; y++) {
				for (let x = 0; x < CELL_W; x++) {
					const coverage = glyph[y * CELL_W + x] / 255;
					if (coverage === 0) continue;
					const off = ((y0 + y) * width + x0 + x) * 3;
					pixels[off] = Math.round(cellBg[0] * (1 - coverage) + cellFg[0] * coverage);
					pixels[off + 1] = Math.round(cellBg[1] * (1 - coverage) + cellFg[1] * coverage);
					pixels[off + 2] = Math.round(cellBg[2] * (1 - coverage) + cellFg[2] * coverage);
				}
			}
		}
	}
	return encodePng(pixels, width, height);
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
