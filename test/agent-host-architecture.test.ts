/**
 * The Agent host dialects live in one module (issue #407, ADR 0141).
 *
 * The plane drives two Agent hosts, `herdr` and `herdr-core`, and the one
 * module `src/agent-host.ts` owns both command dialects: every `herdr` and
 * `hc` argv the plane builds leaves through it, and a surface names the
 * action while the module answers with the command word and its argv. A
 * surface that spells a host's command word inline - `run("herdr", ...)` or
 * `run("hc", ...)` - bypasses that owner, and with it the host word map and
 * the host resolution the surfaces are not to restate.
 *
 * The rule is a declared dependency rule, not a behavior test: the argv the
 * module answers is pinned by the Handoff suite, and the word map and the
 * resolution are held by `test/agent-host.test.ts`. This file refuses the
 * shape a new surface would take to re-introduce the spelling, the way the
 * herdr-view check refuses a `--focus` flag and the shared-control check
 * refuses a screen-built field.
 *
 * The command word is matched as the first argument of a runner call, in
 * either quote, so a surface that re-spells the host command in any runner
 * call fails. What the scan does not read, stated so no reader trusts more
 * than it holds: a command word a function assembles and returns under a
 * variable, or a runner call that receives the word under another name, is
 * not matched by the token scan. The module owns those shapes; a new file
 * that hides a command word in either shape is not caught here, and the
 * closed-surface walk in `test/herdr-world.test.ts` is the check that reaches
 * the argv the plane really sends.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sourceFiles } from "./static-checks.ts";

const sources = sourceFiles("src");

/**
 * The one file allowed to spell a host command word: the module that owns
 * both Agent host dialects. The command word is this module's to name, and no
 * surface's; everything else in the product tree is refused the spelling.
 */
const HOST_MODULE = "src/agent-host.ts";

/** The allowance list: the reason beside the names it covers. */
const ALLOWANCE: Record<string, string> = {
	[HOST_MODULE]: "the Agent host module owns both command dialects and their command words",
};

/**
 * A host command word as the first argument of a runner call, in either
 * quote. The plane's only egress is the Command runner seam, so a command
 * word stands directly beside `run(`; a path segment, a config key, or a
 * command the module hands the runner under a variable matches nothing.
 */
const HOST_COMMAND_ARG = /\brun\s*\(\s*["'](?:herdr|hc)["']\s*[),]/u;

/** Whether one file's text holds a host command argument the allowance does not cover. */
function holdsHostCommandArgument(file: string, text: string): boolean {
	if (file in ALLOWANCE) return false;
	return HOST_COMMAND_ARG.test(text);
}

describe("a host command word stands only in the Agent host module", () => {
	test("the scan reads the plane's own sources", () => {
		// A check that scans nothing passes forever. The module that owns the
		// dialect, and the surfaces that used to spell the word, must be in the
		// set the scan reads.
		for (const required of [
			HOST_MODULE,
			"src/handoff.ts",
			"src/observation.ts",
			"src/consultation-operations.ts",
			"src/consultation/agent-input.ts",
			"src/components/app.ts",
			"src/herdr-identity.ts",
		]) {
			expect(sources, `${required} must be in the scanned set`).toContain(required);
		}
	});

	test("no surface outside the module spells a host command word", () => {
		const offenders = sources.filter((file) =>
			holdsHostCommandArgument(file, readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});

	test("the scan reads the token it refuses", () => {
		// A scan whose pattern matches nothing is worse than no scan: it reads
		// as a guard and enforces nothing. This feeds it the shapes it must
		// catch and the shapes it must leave alone.
		expect(HOST_COMMAND_ARG.test(`await runner.run("herdr", ["agent", "list"])`)).toBe(true);
		expect(HOST_COMMAND_ARG.test(`await ctx.runner.run("hc", ["ls", "--json"])`)).toBe(true);
		expect(HOST_COMMAND_ARG.test(`this.runner.run('herdr', args)`)).toBe(true);
		// A path segment is not a command word: the herdr config lives under a
		// directory spelled `herdr`, and the plane reads it by path.
		expect(HOST_COMMAND_ARG.test(`join(configHome, "herdr", "config.toml")`)).toBe(false);
		// The module's invocation is a variable the caller hands the runner:
		// no command word stands beside `run(`, so the token scan reads nothing.
		expect(HOST_COMMAND_ARG.test(`await runner.run(invocation.command, invocation.args)`)).toBe(
			false,
		);
	});

	test("a probe argv outside the module turns the check red", () => {
		// The probe places a host command argv in a real surface's text, beside
		// the module, and asserts the check now flags that surface. It asserts
		// the text it edited changed, so a probe that matched nothing cannot
		// pass: an early, unverified red is the failure this guards against.
		const probeFile = "src/handoff.ts";
		const original = readFileSync(probeFile, "utf8");
		const edited = `${original}\nconst probe = runner.run("herdr", ["agent", "list"]);\n`;
		expect(edited).not.toBe(original);
		expect(holdsHostCommandArgument(probeFile, original)).toBe(false);
		expect(holdsHostCommandArgument(probeFile, edited)).toBe(true);
	});
});
