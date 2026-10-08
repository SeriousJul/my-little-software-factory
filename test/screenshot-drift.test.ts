/**
 * Drift test: the guide screenshots are screens of the running app, not
 * drawings of the app.
 *
 * The images the operation guide shows are rendered from the production
 * binary on a fixed fixture world: the same config, the same stub agents,
 * the same production keys. When a screen changes and its committed image is
 * not regenerated, this test fails with the images that drifted, and
 * `npm run screenshots` writes the current screens back. The fixture's
 * timestamps are constants, so a faithful capture is byte-stable: a mismatch
 * means the screen moved, not the clock.
 *
 * Two guards stand beside the byte comparison (ADR 0123). The committed
 * PNGs' IHDR dimensions are checked against the pinned scale times their
 * grid without opening a PTY, so a scale change fails with its own reason
 * instead of an opaque byte diff. The rasterizer is checked to produce
 * partial coverage for a curved glyph, so a regression to a hard-edged
 * raster goes red, and a bold cell is checked to stand on the Bold face
 * with no palette index brightened.
 *
 * The probes the guards claim, each re-run on the tree:
 *
 * - The scale probe: move the pinned FONT_SIZE in `scripts/screen-font.ts`.
 *   The committed images no longer stand on the pinned scale, and the
 *   dimension check goes red with one line per image, the header size beside
 *   the pinned one.
 * - The antialias probe: drop the SS supersampling in `scripts/screen-font.ts`
 *   to 1. The curved glyph's coverage becomes hard-edged, no byte stands
 *   strictly between 0 and 255, and the partial-coverage check goes red.
 * - The bold probe: make `glyphOf` ignore its bold argument. The Bold face's
 *   coverage becomes the Regular face's, and the bold check goes red; or
 *   brighten the bold basic color in the renderer's decode, and the check
 *   that SGR 1 with a basic color keeps the index goes red.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { parseScreen, renderPng } from "../scripts/ansi-render.ts";
import { CELL_H, CELL_W, glyphOf } from "../scripts/screen-font.ts";
import {
	generateScreenshots,
	HERO_SCREEN,
	SCREEN,
	SCREENSHOTS,
	TERMINAL_COLORS,
} from "../scripts/screenshot-fixture.ts";
import { ptyAvailable } from "./executable-pty.ts";

/** The IHDR width and height of one PNG, read from its header chunks. */
function ihdrOf(png: Buffer): { width: number; height: number } {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	if (!png.subarray(0, 8).equals(signature)) {
		throw new Error("not a PNG: the signature is wrong");
	}
	if (png.toString("ascii", 12, 16) !== "IHDR") {
		throw new Error("not a PNG: the first chunk is not the IHDR");
	}
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The first pixel of one PNG, decoded from its IDAT's first scanline. */
function firstPixelOf(png: Buffer): [number, number, number] {
	let offset = 8;
	let idat: Buffer | null = null;
	while (offset < png.length) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		if (type === "IDAT") idat = png.subarray(offset + 8, offset + 8 + length);
		offset += 12 + length;
		if (type === "IEND") break;
	}
	if (idat === null) throw new Error("not a PNG: it holds no IDAT chunk");
	// The first scanline: one filter byte, then the first pixel's RGB.
	const raw = inflateSync(idat);
	return [raw[1], raw[2], raw[3]];
}

describe("the guide screenshots", () => {
	it.skipIf(!ptyAvailable())(
		"match the screens the production binary renders",
		async () => {
			let regenerated: Map<string, Buffer>;
			try {
				regenerated = await generateScreenshots();
			} catch (err) {
				if (err instanceof Error && err.message.includes("cannot open a PTY")) {
					// A platform that reports PTY support but still cannot open one is
					// a real failure: a skipped required check is not a pass.
					throw new Error(
						"no pseudo-terminal on this platform: the guide screenshots are unverified",
					);
				}
				throw err;
			}
			const drifted: string[] = [];
			for (const target of SCREENSHOTS) {
				const path = join(import.meta.dirname, "..", "docs", target.docDir, target.file);
				const committed = readFileSync(path);
				const fresh = regenerated.get(target.name);
				if (fresh === undefined) {
					drifted.push(`${target.file}: no capture under that name`);
					continue;
				}
				if (!fresh.equals(committed)) {
					drifted.push(`${target.file}: the screen changed`);
				}
			}
			expect(
				drifted,
				`these guide screenshots no longer match the app: ${drifted.join("; ")} - run npm run screenshots and commit the result`,
			).toEqual([]);
		},
		240_000,
	);
});

describe("the committed images", () => {
	it("match the pinned scale times their grid, without a PTY", () => {
		const drifted: string[] = [];
		for (const target of SCREENSHOTS) {
			const path = join(import.meta.dirname, "..", "docs", target.docDir, target.file);
			const { width, height } = ihdrOf(readFileSync(path));
			const wantW = SCREEN.cols * CELL_W;
			const wantH = SCREEN.rows * CELL_H;
			if (width !== wantW || height !== wantH) {
				drifted.push(
					`${target.file}: the header says ${width} by ${height}, the pinned scale says ${wantW} by ${wantH}`,
				);
			}
		}
		// The hero: the same pinned cell on the hero's own grid.
		const heroPath = join(import.meta.dirname, "..", "docs", "public", "hero.png");
		const hero = ihdrOf(readFileSync(heroPath));
		const wantHeroW = HERO_SCREEN.cols * CELL_W;
		const wantHeroH = HERO_SCREEN.rows * CELL_H;
		if (hero.width !== wantHeroW || hero.height !== wantHeroH) {
			drifted.push(
				`hero.png: the header says ${hero.width} by ${hero.height}, the pinned scale says ${wantHeroW} by ${wantHeroH}`,
			);
		}
		expect(
			drifted,
			`these committed images do not stand on the pinned scale: ${drifted.join("; ")} - run npm run screenshots and npm run hero and commit the result`,
		).toEqual([]);
	});
});

describe("the screenshot renderer", () => {
	it("rasterizes a curved glyph with partial coverage", () => {
		const coverage = glyphOf("o", false);
		expect(coverage).toBeDefined();
		const partial = [...(coverage as Uint8Array)].some((byte) => byte > 0 && byte < 255);
		expect(
			partial,
			"a curved glyph must antialias: some coverage byte stands strictly between 0 and 255",
		).toBe(true);
	});

	it("stands a bold cell on the Bold face, and brightens no palette index", () => {
		const regular = glyphOf("M", false);
		const bold = glyphOf("M", true);
		expect(regular).toBeDefined();
		expect(bold).toBeDefined();
		expect(
			Buffer.from(bold as Uint8Array).equals(Buffer.from(regular as Uint8Array)),
			"the Bold face must rasterize its own coverage, not the Regular face's",
		).toBe(false);
		// SGR 1 with a basic color: the face moves, the index does not.
		const cells = parseScreen(Buffer.from("\x1b[1;31mM\x1b[0m"), 2, 1);
		expect(cells[0][0].bold).toBe(true);
		expect(cells[0][0].fg).toBe(1);
		// A 24-bit color the stream names paints exactly.
		const exact = parseScreen(Buffer.from("\x1b[38;2;40;44;52mX\x1b[0m"), 2, 1);
		expect(exact[0][0].fg).toEqual([40, 44, 52]);
		// A cell that names no background paints the pinned terminal background.
		const blank = renderPng(
			[
				[
					{ char: " ", fg: -1, bg: -1, bold: false },
					{ char: " ", fg: -1, bg: -1, bold: false },
				],
			],
			TERMINAL_COLORS,
		);
		expect(firstPixelOf(blank)).toEqual([26, 27, 38]);
	});
});
