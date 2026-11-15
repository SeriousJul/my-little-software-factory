/**
 * The source half of the record name rule (issue #295 review).
 *
 * The rule is the pair: the ticket's title in quotes, and the identity alone
 * the line falls back to. Three surfaces read it - the Handoff dispatch, the
 * observation cycle, and the boot - and each had its own copy until issue
 * #295. The rule lives in one module, `src/domain/record-name.ts`, and its
 * behavior half stands in the app-boot suites, which pin the pair on the
 * scoped read's narrowed input. This file is the re-homed half of the suite
 * the unit layer removal took: the scan that refuses a second copy of the
 * rule anywhere in the plane. A fourth copy is the drift the shared module
 * exists to stop.
 *
 * The mutation campaign keeps this file out: it reads `src` as text and asks
 * each line for the string shapes it counts, which instrumentation rewrites,
 * so under mutation it fails on a text change rather than on a behavior
 * change. It stays in `bun run test`, which reads the uninstrumented tree.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { sourceFiles } from "./static-checks.ts";

describe("the record name rule keeps one copy (issue #295 review)", () => {
	test("no other file restates the name rule", () => {
		// The scan reads one line at a time and asks for both halves of the pair on
		// that line, in either order, so it is not tied to the one template shape
		// the removed copies wore: a copy that swaps the branches, writes the pair
		// as string concatenation, or puts the quoted title inside a longer
		// sentence is the same rule restated, and it is caught the same way. A
		// line that names a ticket by identity alone - the walk's `ticket I_5
		// held (...)` lines - holds one half of the pair and is not the rule, so
		// it stays out.
		const identityFallback = [/`ticket\s*\$\{[^}]*\}`/u, /["'`]ticket\s+["'`]\s*\+/u];
		const titleInQuotes = [
			/`"\$\{[^}]*\}"`/u,
			/`[^`]*\s"\$\{[^}]*\}"[^`]*`/u,
			/["']"["']\s*\+\s*[\w.[\]]+\s*\+\s*["']"["']/u,
		];
		const restates = (code: string): boolean =>
			code
				.split("\n")
				.some(
					(line) =>
						identityFallback.some((shape) => shape.test(line)) &&
						titleInQuotes.some((shape) => shape.test(line)),
				);
		const offenders = sourceFiles("src")
			.filter((file) => file !== "src/domain/record-name.ts")
			.filter((file) => restates(readFileSync(file, "utf8")));
		expect(offenders).toEqual([]);
		// The scan is not vacuous: each way a copy can be written is caught by it.
		// The placeholders and the backticks are escaped, so this file holds no
		// live restatement of its own.
		const copies = [
			// The shape the removed copies wore.
			`const name = title === undefined ? \`ticket \${identity}\` : \`"\${title}"\`;`,
			// The same pair with the branches swapped.
			`const name = title !== undefined ? \`"\${title}"\` : \`ticket \${identity}\`;`,
			// The pair written as concatenation instead of a template.
			`const name = title === undefined ? "ticket " + identity : '"' + title + '"';`,
			// The quoted title sitting inside a longer sentence.
			`const name = title === undefined ? \`ticket \${identity}\` : \`the Ticket "\${title}" is gone\`;`,
		];
		for (const copy of copies) expect(restates(copy)).toBe(true);
		// And a line that names a ticket one way only stays out of the scan.
		expect(restates(`log.warn(\`ticket \${identity} held (\${cause})\`);`)).toBe(false);
	});
});
