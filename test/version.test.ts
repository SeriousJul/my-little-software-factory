/**
 * Tests for the version the plane reports.
 *
 * A source run reads the repository's package.json, the same file the release
 * workflow checks against the tag. The stamped value a compiled binary
 * carries is set by the build (`--define FACTORY_BUILD_VERSION`), which the
 * build command's test pins; here the source-run path is what is measurable.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { factoryVersion } from "../src/version.ts";

describe("the version the source run reports", () => {
	test("the version is the repository's package.json version", async () => {
		const pkg = JSON.parse(
			readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
		) as { version: string };
		expect(await factoryVersion()).toBe(pkg.version);
	});
});
