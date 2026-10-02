/**
 * Tests for the version sync the release runs before it acts.
 *
 * The tag is the one place the operator names a release (ADR 0090), and the
 * release jobs write the tag's version into the package manifest through
 * `syncVersion` before they build, publish, or check. These tests pin what
 * the write may and may not change: the version field moves, nothing else
 * does, and a manifest that already carries the version comes back
 * byte-identical so a re-run commits nothing.
 */

import { describe, expect, test } from "bun:test";
import { syncVersion } from "../scripts/sync-release-version.ts";

/** A manifest shaped like the package's: the version among other fields. */
const MANIFEST_BEFORE = JSON.stringify({
	name: "my-little-software-factory",
	version: "0.1.0",
	description: "The control plane of my little software factory.",
	license: "MIT",
	files: ["bin/factory-bin.mjs", "src/binary-install.mjs"],
	engines: { bun: ">=1.3.0" },
});

describe("the field the sync moves", () => {
	test("writes the tag's version into the version field", () => {
		const { text, changed } = syncVersion(MANIFEST_BEFORE, "0.0.3");
		expect(changed).toBe(true);
		const after = JSON.parse(text) as Record<string, unknown>;
		expect(after.version).toBe("0.0.3");
	});

	test("leaves every other field and the key order untouched", () => {
		const { text } = syncVersion(MANIFEST_BEFORE, "0.0.3");
		const after = JSON.parse(text) as Record<string, unknown>;
		expect(Object.keys(after)).toEqual([
			"name",
			"version",
			"description",
			"license",
			"files",
			"engines",
		]);
		expect(after.name).toBe("my-little-software-factory");
		expect(after.engines).toEqual({ bun: ">=1.3.0" });
	});

	test("keeps the manifest's tab indent and trailing newline", () => {
		const { text } = syncVersion(MANIFEST_BEFORE, "0.0.3");
		expect(text.split("\n")[1]).toBe(`\t"name": "my-little-software-factory",`);
		expect(text.endsWith("\n")).toBe(true);
	});
});

describe("the write the sync refuses", () => {
	test("a manifest that already carries the version comes back byte-identical", () => {
		const current = `${JSON.stringify(
			{ name: "my-little-software-factory", version: "0.0.3" },
			null,
			"\t",
		)}\n`;
		const { text, changed } = syncVersion(current, "0.0.3");
		expect(changed).toBe(false);
		expect(text).toBe(current);
	});

	test("a version that is not x.y.z throws before any write", () => {
		expect(() => syncVersion(MANIFEST_BEFORE, "0.0")).toThrow(/not a x\.y\.z version/);
		expect(() => syncVersion(MANIFEST_BEFORE, "0.0.3-beta")).toThrow(/not a x\.y\.z version/);
	});
});
