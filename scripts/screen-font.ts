/**
 * The screen font for the screenshot renderer: the glyph rasterizer.
 *
 * The screenshots paint the terminal font the operator's desktop stands on.
 * The two vendored faces - Meslo LG M D Z (MIT) patched with Nerd Fonts
 * glyphs (MIT), Regular and Bold - rasterize at run time, and each glyph's
 * coverage is computed once per face and character, then cached. Each glyph
 * is one CELL_W x CELL_H block of coverage bytes (0-255): the share of the
 * pixel the glyph's ink covers, supersampled from the font's outline. The
 * renderer blends the cell's foreground over its background by that coverage,
 * so a screenshot paints the terminal font with its anti-aliasing, and a
 * bold cell stands on the Bold face (ADR 0123).
 *
 * The retired path committed the coverage as a generated table:
 * `bun run font` over `scripts/generate-screen-font.ts`. The table and the
 * script leave, and this rasterizer stands in their place: the whole glyph
 * set rasterizes in about a tenth of a second, against a capture case that
 * already costs seconds.
 *
 * The cell the grid aligns on comes from the Regular face: the font's
 * advance and its ascent plus descent, each rounded to whole pixels at the
 * pinned 45 px raster size. The Bold face shares the metrics, so a bold cell
 * never shifts the grid.
 *
 * The fill keeps the TTF winding rule (non-zero), with 8x supersampling and
 * 64-piece curve subdivision, no hinting, and no subpixel antialiasing: a
 * browser rescales the PNG, so subpixel coverage would read as colored
 * fringes, and hinting would tie the glyphs to one rasterizer's choices.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { create, type Font, type Path } from "fontkit";

/** The font size the glyphs rasterize at, in device pixels. */
const FONT_SIZE = 45;
/** The supersampling factor: each cell pixel is one square of SS x SS. */
const SS = 8;
/** The pieces one curve subdivides into when the outline flattens. */
const CURVE_PIECES = 64;

// The vendored files are single TTFs, never collections, so the Font side of
// create's union is the one that stands.
const REGULAR = create(
	readFileSync(
		fileURLToPath(new URL("./fonts/MesloLGMDZNerdFontMono-Regular.ttf", import.meta.url)),
	),
) as Font;
const BOLD = create(
	readFileSync(fileURLToPath(new URL("./fonts/MesloLGMDZNerdFontMono-Bold.ttf", import.meta.url))),
) as Font;

/** The cell the terminal gives a column, from the Regular face's metrics. */
export const CELL_W = Math.max(
	1,
	Math.round((REGULAR.glyphForCodePoint(0x4d).advanceWidth * FONT_SIZE) / REGULAR.unitsPerEm),
);
/** The cell the terminal gives a row: the Regular face's ascent plus descent. */
export const CELL_H = Math.max(
	1,
	Math.round(((REGULAR.ascent - REGULAR.descent) * FONT_SIZE) / REGULAR.unitsPerEm),
);

interface Seg {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Flatten one glyph path at the font size into line segments, in cell space. */
function segmentsOf(codePoint: number, font: Font): Seg[] {
	const glyph = font.glyphForCodePoint(codePoint);
	// The path is in the font's design units, baseline at y = 0, y up.
	const scale = FONT_SIZE / font.unitsPerEm;
	// The baseline sits at the ascent; the cell y axis points down.
	const baseY = (font.ascent * FONT_SIZE) / font.unitsPerEm;
	return pathSegments(
		glyph.path,
		(x) => x * scale,
		(y) => baseY - y * scale,
	);
}

/** The path's commands, flattened to line segments the caller maps to cells. */
function pathSegments(path: Path, toX: (x: number) => number, toY: (y: number) => number): Seg[] {
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
	const flattenCurve = (pts: readonly number[]) => {
		const [x1, y1, x2, y2, x3, y3] = pts;
		// De Casteljau subdivision into CURVE_PIECES pieces.
		let px = cx;
		let py = cy;
		for (let i = 1; i <= CURVE_PIECES; i++) {
			const t = i / CURVE_PIECES;
			const u = 1 - t;
			const x = u * u * u * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
			const y = u * u * u * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
			segs.push({ x0: toX(px), y0: toY(py), x1: toX(x), y1: toY(y) });
			px = x;
			py = y;
		}
	};
	for (const cmd of path.commands) {
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
			flattenCurve([
				cx + (2 / 3) * (qx - cx),
				cy + (2 / 3) * (qy - cy),
				rx + (2 / 3) * (qx - rx),
				ry + (2 / 3) * (qy - ry),
				rx,
				ry,
			]);
			cx = rx;
			cy = ry;
		} else if (cmd.command === "bezierCurveTo") {
			flattenCurve(cmd.args);
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
	const coverage = new Float32Array(gridW * gridH);
	for (let gy = 0; gy < gridH; gy++) {
		const y = (gy + 0.5) / SS;
		const edges: { x: number; dir: number }[] = [];
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
			coverage[gy * gridW + gx] = winding !== 0 ? 1 : 0;
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

/** The rasterized coverage, keyed by face and code point. */
const coverageCache = new Map<string, Uint8Array>();

/**
 * The coverage block of a cell character on its face, or undefined when the
 * face has no glyph for it.
 */
export function glyphOf(char: string, bold: boolean): Uint8Array | undefined {
	const codePoint = char.codePointAt(0);
	if (codePoint === undefined) return undefined;
	const face = bold ? BOLD : REGULAR;
	const key = `${bold ? 1 : 0}:${codePoint}`;
	const cached = coverageCache.get(key);
	if (cached !== undefined) return cached;
	if (!face.hasGlyphForCodePoint(codePoint)) return undefined;
	const coverage = rasterize(segmentsOf(codePoint, face), CELL_W, CELL_H);
	coverageCache.set(key, coverage);
	return coverage;
}
