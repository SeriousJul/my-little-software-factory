/**
 * Generate the documentation screenshots from the production binary.
 *
 * `npm run screenshots` builds the fixture world (a config, a seeded state
 * file, and stub executables for the world's external commands), runs the
 * real control plane on a pseudo-terminal through the six screens the guides
 * show, renders each screen to a PNG, and writes the PNGs into the docs
 * folders that show them. The drift test in the suite reruns this into a
 * temporary tree and rejects any committed PNG that no longer matches the
 * screen, so an image change is always a screen change on a purpose.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateScreenshots, SCREENSHOTS } from "./screenshot-fixture.ts";

const DOCS_ROOT = fileURLToPath(new URL("../docs", import.meta.url));

const shots = await generateScreenshots();
for (const target of SCREENSHOTS) {
	const png = shots.get(target.name);
	if (png === undefined) {
		console.error(`screenshots: the capture returned no screen named ${target.name}`);
		process.exit(1);
	}
	const out = join(DOCS_ROOT, target.docDir, target.file);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, png);
	console.log(`screenshots: wrote ${out} (${png.length} bytes)`);
}
