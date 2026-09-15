/**
 * The screenshot renderer: one terminal cell per rectangle, the real palette.
 *
 * It reads the ANSI byte stream a PTY session captured from the production
 * renderer and reduces it to the screen the operator sees: a grid of
 * (character, foreground, background) cells. It then paints that grid to a
 * PNG: each cell in its background color, its glyph blended over the
 * background by the per-pixel coverage the font table carries, the 256-color
 * palette expanded to the RGB values the stream named. The committed
 * screenshots are the output of this renderer over the captured stream, so
 * an image change is always a screen change.
 *
 * The parser keeps only what the production stream uses: cursor addressing
 * and movement, character attributes (SGR), line endings, and everything
 * else (modes, queries, OSC strings, charset selects) ignored. The screen is
 * the size the session was opened with; a cell outside it is dropped.
 */

import { deflateSync } from "node:zlib";

import { CELL_H, CELL_W, glyphOf } from "./screen-font.ts";

/** One cell of the terminal grid. */
interface Cell {
	char: string;
	fg: number;
	bg: number;
}

/** The xterm 256-color palette, as the terminal that paints the app has it. */
const PALETTE: readonly [number, number, number][] = (() => {
	const colors: [number, number, number][] = [];
	// The 16 system colors: the xterm defaults.
	const system: [number, number, number][] = [
		[0, 0, 0],
		[205, 0, 0],
		[0, 205, 0],
		[205, 205, 0],
		[0, 0, 238],
		[205, 0, 205],
		[0, 205, 205],
		[229, 229, 229],
		[127, 127, 127],
		[255, 0, 0],
		[0, 255, 0],
		[255, 255, 0],
		[92, 92, 255],
		[255, 0, 255],
		[0, 255, 255],
		[255, 255, 255],
	];
	colors.push(...system);
	// The 216-color cube.
	for (let r = 0; r < 6; r++)
		for (let g = 0; g < 6; g++)
			for (let b = 0; b < 6; b++)
				colors.push([r * 42 + (r ? 55 : 0), g * 42 + (g ? 55 : 0), b * 42 + (b ? 55 : 0)]);
	// The 24 gray ramp.
	for (let i = 0; i < 24; i++) colors.push([8 + i * 10, 8 + i * 10, 8 + i * 10]);
	return colors;
})();

const rgbOf = (index: number): [number, number, number] => PALETTE[index] ?? [0, 0, 0];

/** The background one terminal cell has when the stream names no color for it. */
const DEFAULT_BG = [17, 17, 27] as const;
/** The default foreground, xterm's bright white. */
const DEFAULT_FG = 15;

/**
 * Reduce an ANSI byte stream to the cell grid of the screen it ends on.
 *
 * `cols` and `rows` are the size the PTY was opened with: the grid the
 * renderer drew into, and the size the screenshot shows.
 */
export function parseScreen(data: Uint8Array, cols: number, rows: number): Cell[][] {
	const cells: Cell[][] = Array.from({ length: rows }, () =>
		Array.from({ length: cols }, () => ({ char: " ", fg: DEFAULT_FG, bg: -1 })),
	);
	let row = 0;
	let col = 0;
	let fg = DEFAULT_FG;
	let bg = -1;
	let bold = false;
	let text = "";
	const decoder = new TextDecoder();

	const emit = (ch: string) => {
		if (row < 0 || row >= rows || col < 0 || col >= cols) return;
		cells[row][col] = { char: ch, fg, bg };
		col += 1;
		if (col >= cols) {
			col = 0;
			row += 1;
		}
	};
	const applyFg = (value: number) => {
		fg = bold && value < 8 ? value + 8 : value;
	};

	/** Finish the pending plain-text run and reset the SGR state for a CSI. */
	const flush = () => {
		for (const ch of decoder.decode(text ? Buffer.from(text, "latin1") : new Uint8Array())) {
			emit(ch);
		}
		text = "";
	};

	const decode = (params: string): void => {
		const p = params
			.split(";")
			.map((part) => (part === "" ? 0 : Number(part)))
			.filter((n) => Number.isFinite(n));
		if (params.trim() === "") return;
		switch (p[p.length - 1]) {
			case 49:
				bg = -1;
				break;
			case 0:
				fg = DEFAULT_FG;
				bg = -1;
				bold = false;
				break;
			case 1:
				bold = true;
				break;
			case 22:
				bold = false;
				break;
			case 39:
				fg = DEFAULT_FG;
				break;
			default:
				break;
		}
		for (let i = 0; i < p.length; i++) {
			const code = p[i];
			if (code >= 30 && code <= 37) applyFg(code - 30);
			else if (code >= 90 && code <= 97) applyFg(code - 90 + 8);
			else if (code === 40 || (code >= 40 && code <= 47)) bg = code - 40;
			else if (code >= 100 && code <= 107) bg = code - 100 + 8;
			else if (code === 38) {
				if (p[i + 1] === 5 && p[i + 2] !== undefined) {
					applyFg(p[i + 2]);
					i += 2;
				} else if (p[i + 1] === 2) {
					fg = indexFromTrueColor(p.slice(i + 2, i + 5));
					i += 4;
				}
			} else if (code === 48) {
				if (p[i + 1] === 5 && p[i + 2] !== undefined) {
					bg = p[i + 2];
					i += 2;
				} else if (p[i + 1] === 2) {
					bg = indexFromTrueColor(p.slice(i + 2, i + 5));
					i += 4;
				}
			}
		}
	};

	const indexFromTrueColor = (rgb: number[]): number => {
		const [r, g, b] = [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0];
		// Nearest palette entry: screenshots must be palette-exact.
		let best = 0;
		let bestDist = Infinity;
		for (let i = 0; i < PALETTE.length; i++) {
			const [pr, pg, pb] = PALETTE[i];
			const dist = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
			if (dist < bestDist) {
				bestDist = dist;
				best = i;
			}
		}
		return best;
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
							if (inCursor) cells[r][c] = { char: " ", fg: DEFAULT_FG, bg: -1 };
						}
				} else if (final === "K") {
					const which = Number(params) || 0;
					for (let c = 0; c < cols; c++) {
						const inCursor = which === 0 ? c >= col : which === 1 ? c <= col : true;
						if (inCursor) cells[row][c] = { char: " ", fg: DEFAULT_FG, bg: -1 };
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
 * coverage blends the foreground over it, pixel by pixel. A background of -1
 * is the terminal's own background, which the stream does not name: it is
 * painted with the theme's base.
 */
export function renderPng(cells: Cell[][], bgOverride?: [number, number, number]): Buffer {
	const cols = cells[0]?.length ?? 0;
	const rows = cells.length;
	const width = cols * CELL_W;
	const height = rows * CELL_H;
	const pixels = Buffer.alloc(width * height * 3);
	const bg = bgOverride ?? DEFAULT_BG;

	for (let r = 0; r < rows; r++) {
		for (let c = 0; c < cols; c++) {
			const cell = cells[r][c];
			const cellBg = cell.bg === -1 ? bg : rgbOf(cell.bg);
			const cellFg = rgbOf(cell.fg);
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
			const glyph = glyphOf(cell.char);
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
