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
	const cells: Cell[][] = Array.from({ length: rows }, () =>
		Array.from({ length: cols }, () => ({ char: " ", fg: -1, bg: -1, bold: false })),
	);
	let row = 0;
	let col = 0;
	let fg: CellColor = -1;
	let bg: CellColor = -1;
	let bold = false;
	let text = "";
	const decoder = new TextDecoder();

	const emit = (ch: string) => {
		if (row < 0 || row >= rows || col < 0 || col >= cols) return;
		cells[row][col] = { char: ch, fg, bg, bold };
		col += 1;
		if (col >= cols) {
			col = 0;
			row += 1;
		}
	};

	/** Finish the pending plain-text run and reset the SGR state for a CSI. */
	const flush = () => {
		for (const ch of decoder.decode(text ? Buffer.from(text, "latin1") : new Uint8Array())) {
			emit(ch);
		}
		text = "";
	};

	/**
	 * One 256-color index, as the terminal resolves it: a basic index, or the
	 * exact RGB of the cube or ramp. An index no terminal names - a broken
	 * stream past 255, or a negative one - falls back to black.
	 */
	const colorOf256 = (index: number): CellColor => {
		if (index < 0 || index > 255) return [0, 0, 0];
		return index < 16 ? index : xterm256(index);
	};

	/**
	 * Read one extended SGR color: `38`/`48`, a mode, and the values.
	 * Returns the color and the index past the sequence, or null when the
	 * parameters name no color.
	 */
	const extendedColor = (p: number[], i: number): { color: CellColor; next: number } | null => {
		if (p[i + 1] === 5 && Number.isFinite(p[i + 2])) {
			return { color: colorOf256(p[i + 2]), next: i + 3 };
		}
		if (p[i + 1] === 2) {
			return { color: [p[i + 2] ?? 0, p[i + 3] ?? 0, p[i + 4] ?? 0], next: i + 5 };
		}
		return null;
	};

	const decode = (params: string): void => {
		const p = params.split(";").map((part) => (part === "" ? 0 : Number(part)));
		if (params.trim() === "") return;
		for (let i = 0; i < p.length; i++) {
			const code = p[i];
			if (code === 0) {
				fg = -1;
				bg = -1;
				bold = false;
			} else if (code === 1) {
				bold = true;
			} else if (code === 22) {
				bold = false;
			} else if (code === 39) {
				fg = -1;
			} else if (code === 49) {
				bg = -1;
			} else if (code >= 30 && code <= 37) {
				fg = code - 30;
			} else if (code >= 90 && code <= 97) {
				fg = code - 90 + 8;
			} else if (code >= 40 && code <= 47) {
				bg = code - 40;
			} else if (code >= 100 && code <= 107) {
				bg = code - 100 + 8;
			} else if (code === 38 || code === 48) {
				const extended = extendedColor(p, i);
				if (extended !== null) {
					if (code === 38) fg = extended.color;
					else bg = extended.color;
					i = extended.next - 1;
				}
			}
		}
	};

	let i = 0;
	while (i < data.length) {
		const byte = data[i];
		if (byte === 0x1b) {
			flush();
			if (i + 1 >= data.length) break;
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
				if (j >= data.length) break;
				const final = String.fromCharCode(data[j]);
				if (final === "m") {
					if (params !== "") decode(params);
				} else if (final === "H" || final === "f") {
					const [r = "1", c = "1"] = (params === "" ? "" : params).split(";");
					row = Number(r) - 1;
					col = Number(c) - 1;
				} else if (final === "A") {
					row = Math.max(0, row - (Number(params) || 1));
				} else if (final === "B" || final === "e") {
					row = Math.min(rows - 1, row + (Number(params) || 1));
				} else if (final === "C" || final === "a") {
					col = Math.min(cols - 1, col + (Number(params) || 1));
				} else if (final === "D") {
					col = Math.max(0, col - (Number(params) || 1));
				} else if (final === "E") {
					row = Math.min(rows - 1, row + (Number(params) || 1));
					col = 0;
				} else if (final === "F") {
					row = Math.max(0, row - (Number(params) || 1));
					col = 0;
				} else if (final === "G" || final === "`") {
					col = Math.max(0, Number(params) - 1);
				} else if (final === "d") {
					row = Math.max(0, Number(params) - 1);
				} else if (final === "J") {
					const which = Number(params) || 0;
					for (let r = 0; r < rows; r++)
						for (let c = 0; c < cols; c++) {
							const inCursor =
								which === 0
									? (r === row && c <= col) || r < row
									: which === 1
										? (r === row && c >= col) || r > row
										: true;
							if (inCursor) cells[r][c] = { char: " ", fg: -1, bg: -1, bold: false };
						}
				} else if (final === "K") {
					const which = Number(params) || 0;
					for (let c = 0; c < cols; c++) {
						const inCursor = which === 0 ? c >= col : which === 1 ? c <= col : true;
						if (inCursor) cells[row][c] = { char: " ", fg: -1, bg: -1, bold: false };
					}
				}
				// Modes (?25l, ?1049h, ?1006h, ...), queries (6n), and the
				// rest never touch the grid.
				i = j + 1;
				continue;
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
				i = j + 1;
				continue;
			}
			// Other escapes: a two-byte sequence (charset select, etc.).
			i += 2;
			continue;
		}
		if (byte === 0x0d) {
			flush();
			col = 0;
			i += 1;
			continue;
		}
		if (byte === 0x0a) {
			flush();
			row = Math.min(rows - 1, row + 1);
			i += 1;
			continue;
		}
		if (byte === 0x08) {
			flush();
			col = Math.max(0, col - 1);
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
		text += String.fromCharCode(byte);
		i += 1;
	}
	flush();
	return cells;
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
