/**
 * Tests for the Default configuration the plane ships.
 *
 * The file is imported as a file (src/shipped-default.ts): the read that
 * seeds a missing config file must reach the same bytes in a source run and
 * in a compiled binary, where the module's own directory is a virtual path
 * that holds code only. The compiled read is exercised by the release
 * build's smoke steps; here the source-run read is pinned to the checked-in
 * file, so the two cannot drift.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

import { validateConfig } from "../src/config.ts";
import { readShippedDefaultConfigText, shippedDefaultConfigPath } from "../src/shipped-default.ts";

/** The checked-in Default configuration. */
const CHECKED_IN = fileURLToPath(new URL("../config/default.toml", import.meta.url));

describe("the shipped Default configuration", () => {
	test("the path resolves to the checked-in file in a source run", () => {
		expect(shippedDefaultConfigPath()).toBe(CHECKED_IN);
	});

	test("the read returns the checked-in file's text, verbatim", async () => {
		expect(await readShippedDefaultConfigText()).toBe(readFileSync(CHECKED_IN, "utf8"));
	});

	test("the shipped text validates, so a first run always seeds a usable config", async () => {
		const config = validateConfig(parse(await readShippedDefaultConfigText()));
		expect(config.defaultAgent).toBe("pi");
		expect(config.defaultEnvironment).toBe("worktree");
	});
});
