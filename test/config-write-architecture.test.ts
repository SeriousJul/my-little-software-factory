/**
 * The config write-back is one rule, not two (ADR 0103).
 *
 * The control plane writes back to the operator's config file from two
 * surfaces: the Consultation and handoff paths record a repository mapping
 * they discover, and the Repository init registers the sources it generated.
 * Both stand under one rule: they call `writeConfigFile`, which edits the
 * `[repos]` table and the `[[sources]]` blocks the plane owns and leaves the
 * rest of the operator's file where the operator wrote it.
 *
 * This is a declared dependency rule, not a behavior test. What the operator
 * sees is checked by `test/repo-init-stub.test.ts` and
 * `test/handoff-frame.test.ts`, which drive the real screens and read the
 * file on disk; `test/config-write.test.ts` holds the edit itself. This file
 * refuses the shape a new write-back would take to re-add a whole-file
 * rewrite, so the operator's comments cannot be lost by a second rule nobody
 * reviewed.
 *
 * One limit, stated so no reader trusts more than it holds: the scan reads
 * call sites by name. A write-back that reaches the disk through a helper of
 * its own - a `writeFile` of the config path - is not matched here. The
 * frame seams own that shape; a new file that writes the config file directly
 * is caught by the frame tests that read the file back, not by this scan.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sourceFiles } from "./static-checks.ts";

const sources = sourceFiles("src");

/** The whole-file writer ADR 0103 retires as a call site. */
const WHOLE_FILE_WRITE = /\bpersistConfig\s*\(/u;
/** The one write-back entry point. */
const SECTION_WRITE = /\bwriteConfigFile\s*\(/u;
/** The disk step under the entry point: no surface reaches past the module for it. */
const RAW_CONFIG_WRITE = /\bwriteConfigText\s*\(/u;
/** The rewrite fact, in the words the plane says to the operator. */
const REWRITE_WORDING = /was rewritten/u;

describe("the config write-back is one rule (ADR 0103)", () => {
	test("the scan reads the plane's own sources", () => {
		// A check that scans nothing passes forever. The two surfaces that
		// write the config file back must be in the set the scan reads.
		for (const required of ["src/components/app.ts", "src/config-write.ts", "src/config.ts"]) {
			expect(sources, `${required} must be in the scanned set`).toContain(required);
		}
	});

	test("no source writes the config file with the whole-file writer", () => {
		const offenders = sources.filter((file) => WHOLE_FILE_WRITE.test(readFileSync(file, "utf8")));
		expect(offenders).toEqual([]);
	});

	test("both write-backs go through the one entry point", () => {
		const callers = sources.filter(
			(file) => file !== "src/config-write.ts" && SECTION_WRITE.test(readFileSync(file, "utf8")),
		);
		// The Consultation/handoff mapping write and the Repository init's
		// source write: two call sites, one module that owns the edit.
		expect(callers).toEqual(["src/components/app.ts"]);
		const app = readFileSync("src/components/app.ts", "utf8");
		const calls = app.match(/await writeConfigFile\(/g) ?? [];
		expect(calls).toHaveLength(2);
	});

	test("only the write-back module words the rewrite", () => {
		const offenders = sources.filter(
			(file) => file !== "src/config-write.ts" && REWRITE_WORDING.test(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});

	test("no surface reaches past the module to the disk step", () => {
		const offenders = sources.filter(
			(file) =>
				file !== "src/config.ts" &&
				file !== "src/config-write.ts" &&
				RAW_CONFIG_WRITE.test(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});
});
