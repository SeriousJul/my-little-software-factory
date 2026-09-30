#!/usr/bin/env bun
/**
 * Standalone bin wrapper for the Stub world CLI (issue #178, ADR 0073).
 *
 * The world CLI is a development surface the operator runs beside the Stub
 * run: it edits the world file between turns. The gallery's precedent for a
 * development surface driven from the real entry: the module lives in the
 * product source and runs from this real entry, not a twin of it.
 */
import { worldCli } from "../src/stub/cli.ts";

const result = await worldCli(process.argv.slice(2));
for (const line of result.lines) {
	process.stdout.write(`${line}\n`);
}
process.exit(result.ok ? 0 : 1);
