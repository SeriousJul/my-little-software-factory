/**
 * Generate scripts/screen-font.ts from the vendored terminal font.
 *
 * The screenshots are painted from per-cell coverage bitmaps, not from the
 * host's terminal. This tool rasterizes the vendored TTF into those
 * bitmaps: every character the app's screens can show is drawn at the cell
 * size, supersampled, and reduced to one coverage byte (0-255) per pixel.
 * The renderer blends the cell's foreground over its background by that
 * coverage, so the glyphs in a screenshot are the terminal font's, with its
 * anti-aliasing.
 *
 * Run `npm run font` to regenerate. The output is committed: the drift test
 * renders the committed PNGs from the committed table, so the table and the
 * images must move together.
 *
 * The vendored TTF is `scripts/fonts/MesloLGMDZNerdFontMono-Regular.ttf`:
 * Meslo LG M D Z (MIT) patched with Nerd Fonts glyphs (MIT). It is the
 * operator's terminal font, committed so the screenshots render the same
 * glyphs on any machine.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "fontkit";

/** The font the operator's terminal paints the app with. */
const TTF = fileURLToPath(new URL("./fonts/MesloLGMDZNerdFontMono-Regular.ttf", import.meta.url));

/** The font size the glyphs rasterize at, in device pixels. */
const FONT_SIZE = 15;
/** The supersampling factor: each cell pixel is one square of SS x SS. */
const SS = 4;

/**
 * The characters the screens can show: printable ASCII, the box drawing the
 * views frame with, the blocks the Live view fills with, and the symbols
 * the state words and the key guide name.
 */
const CHARS: string[] = [
	...Array.from({ length: 94 }, (_, i) => String.fromCharCode(0x21 + i)),
	..."─│┌┐└┘├┤┬┴┼▔▒░█▀▄▸▾▴◂●○■□◆",
	..."→←↑↓⚠…⌫❯✕✓┍┑┓┗┝┥┭┵╌╎╏═║",
];

interface Seg {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Flatten one glyph path at the font size into line segments, in cell space. */
function segmentsOf(codePoint: number, font: ReturnType<typeof create>): Seg[] {
	const glyph = font.glyphForCodePoint(codePoint);
	// The path is in the font's design units, baseline at y = 0, y up.
	const path = glyph.path;
	const scale = FONT_SIZE / font.unitsPerEm;
	// The baseline sits at the ascent; the cell y axis points down.
	const baseY = (font.ascent * FONT_SIZE) / font.unitsPerEm;
	const toX = (x: number) => x * scale;
	const toY = (y: number) => baseY - y * scale;

	const segs: Seg[] = [];
	let cx = 0;
	let cy = 0;
	let startX = 0;
	let startY = 0;
	let open = false;
	const closeContour = () => {
		if (!open) return;
		segs.push({ x0: toX(cx), y0: toY(cy), x1: toX(startX), y1: toY(startY) });
		open = false;
	};
	const flattenCurve = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
		// De Casteljau subdivision into 16 pieces: enough for a 36x80 grid.
		const n = 16;
		let px = cx;
		let py = cy;
		for (let i = 1; i <= n; i++) {
			const t = i / n;
			const u = 1 - t;
			const x = u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
			const y = u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
			segs.push({ x0: toX(px), y0: toY(py), x1: toX(x), y1: toY(y) });
			px = x;
			py = y;
		}
	};
	for (const cmd of path.commands as {
		command: string;
		args: number[];
	}[]) {
		if (cmd.command === "moveTo") {
			closeContour();
			cx = cmd.args[0];
			cy = cmd.args[1];
			startX = cx;
			startY = cy;
			open = true;
		} else if (cmd.command === "lineTo") {
			segs.push({ x0: toX(cx), y0: toY(cy), x1: toX(cmd.args[0]), y1: toY(cmd.args[1]) });
			cx = cmd.args[0];
			cy = cmd.args[1];
		} else if (cmd.command === "quadraticCurveTo") {
			const [qx, qy, rx, ry] = cmd.args;
			// Promote the quadratic to a cubic.
			flattenCurve(
				cx + (2 / 3) * (qx - cx),
				cy + (2 / 3) * (qy - cy),
				rx + (2 / 3) * (qx - rx),
				ry + (2 / 3) * (qy - ry),
				rx,
				ry,
			);
			cx = rx;
			cy = ry;
		} else if (cmd.command === "bezierCurveTo") {
			flattenCurve(cmd.args[0], cmd.args[1], cmd.args[2], cmd.args[3], cmd.args[4], cmd.args[5]);
			cx = cmd.args[4];
			cy = cmd.args[5];
		} else if (cmd.command === "closePath") {
			closeContour();
		}
	}
	// A subpath the font leaves open still closes for the fill rule.
	closeContour();
	return segs;
}

/**
 * Rasterize the segments to a CELL_W x CELL_H coverage grid.
 *
 * The fill follows the TTF winding rule (non-zero): each segment adds its
 * signed crossing weight to the scanline edges, and a pixel is covered by
 * the mean of its supersample points' winding counts, clamped to 0-1.
 */
function rasterize(segs: Seg[], cellW: number, cellH: number): Uint8Array {
	const gridW = cellW * SS;
	const gridH = cellH * SS;
	// For each supersample scanline, the list of (x, direction) crossings.
	const coverage = new Float32Array(gridW * gridH);
	for (let gy = 0; gy < gridH; gy++) {
		const y = (gy + 0.5) / SS;
		interface Edge {
			x: number;
			dir: number;
		}
		const edges: Edge[] = [];
		for (const s of segs) {
			const y0 = s.y0;
			const y1 = s.y1;
			if (y0 === y1) continue;
			const below = Math.min(y0, y1);
			const above = Math.max(y0, y1);
			if (y <= below || y >= above) continue;
			const t = (y - y0) / (y1 - y0);
			edges.push({ x: s.x0 + t * (s.x1 - s.x0), dir: y1 > y0 ? 1 : -1 });
		}
		edges.sort((a, b) => a.x - b.x);
		let winding = 0;
		let e = 0;
		for (let gx = 0; gx < gridW; gx++) {
			const x = (gx + 0.5) / SS;
			while (e < edges.length && edges[e].x <= x) {
				winding += edges[e].dir;
				e += 1;
			}
			const inside = winding !== 0 ? 1 : 0;
			for (let sy = 0; sy < SS; sy++) coverage[gy * gridW + gx] = inside;
		}
	}
	// Reduce the supersample grid to one byte per cell pixel.
	const out = new Uint8Array(cellW * cellH);
	for (let y = 0; y < cellH; y++) {
		for (let x = 0; x < cellW; x++) {
			let sum = 0;
			for (let sy = 0; sy < SS; sy++)
				for (let sx = 0; sx < SS; sx++) sum += coverage[(y * SS + sy) * gridW + (x * SS + sx)];
			out[y * cellW + x] = Math.round((sum / (SS * SS)) * 255);
		}
	}
	return out;
}

const font = create(readFileSync(TTF));
const scale = FONT_SIZE / font.unitsPerEm;
// The cell the terminal gives a column: the font's advance, and its
// ascent plus descent, each rounded to whole pixels.
const cellW = Math.max(1, Math.round(font.glyphForCodePoint(0x4d).advanceWidth * scale));
const cellH = Math.max(1, Math.round(((font.ascent - font.descent) * FONT_SIZE) / font.unitsPerEm));
console.log(
	`font: ${font.postscriptName} at ${FONT_SIZE}px - cell ${cellW}x${cellH}, supersample ${SS}x`,
);

const table: { char: string; bytes: Uint8Array }[] = [];
for (const char of CHARS) {
	const cp = char.codePointAt(0);
	if (cp === undefined) continue;
	if (!font.hasGlyphForCodePoint(cp)) {
		console.warn(`font: no glyph for U+${cp.toString(16).padStart(4, "0")} (${char})`);
		continue;
	}
	table.push({ char, bytes: rasterize(segmentsOf(cp, font), cellW, cellH) });
}

// The generated file: the cell size, the flat coverage table in base64, and
// the character to offset index the renderer looks up by cell character.
const flat = Buffer.alloc(table.length * cellW * cellH);
for (let i = 0; i < table.length; i++) {
	flat.set(table[i].bytes, i * cellW * cellH);
}
const b64Lines = flat.toString("base64").match(/.{1,96}/g);
if (b64Lines === undefined) throw new Error("font: the coverage table did not encode");
const b64 = b64Lines.map((line) => `\t"${line}",`).join("\n");
const index = table.map((entry, i) => `\t${JSON.stringify(entry.char)}: ${i},`).join("\n");

const header = `/**
 * The screen font for the screenshot renderer, generated from
 * scripts/fonts/MesloLGMDZNerdFontMono-Regular.ttf by
 * scripts/generate-screen-font.ts (\`npm run font\`). Do not edit by hand.
 *
 * Each glyph is one CELL_W x CELL_H block of coverage bytes (0-255): the
 * share of the pixel the glyph's ink covers, supersampled from the font.
 * The renderer blends the cell's foreground over its background by that
 * coverage, so a screenshot paints the terminal font with its
 * anti-aliasing.
 */

export const CELL_W = ${cellW};
export const CELL_H = ${cellH};

const COVERAGE = Uint8Array.from(
	Buffer.from([
${b64}
	].join(""), "base64"),
);

const INDEX: Record<string, number> = {
${index}
};

/** The coverage block of a cell character, or undefined when the font has no glyph for it. */
export function glyphOf(char: string): Uint8Array | undefined {
	const offset = INDEX[char];
	if (offset === undefined) return undefined;
	const start = offset * CELL_W * CELL_H;
	return COVERAGE.subarray(start, start + CELL_W * CELL_H);
}
`;

const out = join(fileURLToPath(new URL(".", import.meta.url)), "screen-font.ts");
writeFileSync(out, header);
console.log(`font: wrote ${out} (${table.length} glyphs, ${flat.length} bytes of coverage)`);
