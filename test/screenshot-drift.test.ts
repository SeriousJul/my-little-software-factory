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
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateScreenshots, SCREENSHOTS } from "../scripts/screenshot-fixture.ts";
import { ptyAvailable } from "./executable-pty.ts";

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
