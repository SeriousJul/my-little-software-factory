/**
 * Tests for the version sync the release runs before it acts.
 *
 * The tag is the one place the operator names a release (ADR 0090), and the
 * release jobs write the tag's version into the manifests through
 * `syncVersion` before they build, publish, or check. These tests pin what
 * the write may and may not change: the version fields and the alias's pin
 * move, nothing else does, and a manifest that already carries the version
 * comes back byte-identical so a re-run commits nothing.
 */

import { describe, expect, test } from "bun:test";
import { syncVersion } from "../scripts/sync-release-version.ts";

/** A manifest shaped like the alias's: name, version, and the main pin. */
const ALIAS_BEFORE = JSON.stringify({
	name: "mlsf",
	version: "0.1.0",
	description: "The short name for the control plane.",
	license: "MIT",
	dependencies: { "my-little-software-factory": "0.1.0" },
	engines: { node: ">=18" },
});

describe("the fields the sync moves", () => {
	test("writes the tag's version into the version field and the alias's pin", () => {
		const { text, changed } = syncVersion(ALIAS_BEFORE, "0.0.3");
		expect(changed).toBe(true);
		const after = JSON.parse(text) as Record<string, unknown>;
		expect(after.version).toBe("0.0.3");
		expect((after.dependencies as Record<string, string>)["my-little-software-factory"]).toBe(
			"0.0.3",
		);
	});

	test("leaves every other field and the key order untouched", () => {
		const { text } = syncVersion(ALIAS_BEFORE, "0.0.3");
		const after = JSON.parse(text) as Record<string, unknown>;
		expect(Object.keys(after)).toEqual([
			"name",
			"version",
			"description",
			"license",
			"dependencies",
			"engines",
		]);
		expect(after.name).toBe("mlsf");
		expect(after.engines).toEqual({ node: ">=18" });
	});

	test("keeps the manifest's tab indent and trailing newline", () => {
		const { text } = syncVersion(ALIAS_BEFORE, "0.0.3");
		expect(text.split("\n")[1]).toBe(`\t"name": "mlsf",`);
		expect(text.endsWith("\n")).toBe(true);
	});

	test("a manifest without the main pin keeps no dependencies of its own", () => {
		const { text, changed } = syncVersion(
			`${JSON.stringify({ name: "my-little-software-factory", version: "0.1.0" }, null, "\t")}\n`,
			"0.0.3",
		);
		expect(changed).toBe(true);
		const after = JSON.parse(text) as Record<string, unknown>;
		expect(after.version).toBe("0.0.3");
		expect(after.dependencies).toBeUndefined();
	});
});

describe("the write the sync refuses", () => {
	test("a manifest that already carries the version comes back byte-identical", () => {
		const current = `${JSON.stringify(
			{
				name: "mlsf",
				version: "0.0.3",
				dependencies: { "my-little-software-factory": "0.0.3" },
			},
			null,
			"\t",
		)}\n`;
		const { text, changed } = syncVersion(current, "0.0.3");
		expect(changed).toBe(false);
		expect(text).toBe(current);
	});

	test("a version that is not x.y.z throws before any write", () => {
		expect(() => syncVersion(ALIAS_BEFORE, "0.0")).toThrow(/not a x\.y\.z version/);
		expect(() => syncVersion(ALIAS_BEFORE, "0.0.3-beta")).toThrow(/not a x\.y\.z version/);
	});
});
