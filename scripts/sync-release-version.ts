#!/usr/bin/env bun
/**
 * Sync the package manifest to the version the release tag names.
 *
 * The tag is the one place the operator names a release (ADR 0090): the
 * operator cuts the tag from the GitHub interface and no local step is
 * allowed to move the version first. Every release job that reads or writes
 * a version runs this script before it acts, so the tree it builds,
 * publishes, and checks carries the tag's version.
 *
 * The script edits the manifest in place:
 *   package.json  the "version" field
 *
 * A manifest that already carries the version is left byte-identical, so a
 * re-run of a release job re-syncs nothing and commits nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The manifest paths, relative to the repository root. */
export const MANIFEST_PATHS = ["package.json"];

export type Manifest = {
	version?: string;
	[key: string]: unknown;
};

/**
 * Write the version into one manifest's text.
 *
 * Returns the serialized manifest and whether the field moved. The
 * serialization keeps the manifest's key order and tab indent, so a
 * manifest that already carries the version comes back byte-identical.
 */
export function syncVersion(text: string, version: string): { text: string; changed: boolean } {
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`${version} is not a x.y.z version`);
	}
	const manifest = JSON.parse(text) as Manifest;
	const changed = manifest.version !== version;
	if (changed) manifest.version = version;
	return { text: `${JSON.stringify(manifest, null, "\t")}\n`, changed };
}

if (import.meta.main) {
	const [version] = process.argv.slice(2);
	if (version === undefined || version === "") {
		console.error("usage: bun scripts/sync-release-version.ts <version>");
		process.exit(2);
	}
	const root = join(import.meta.dir, "..");
	try {
		for (const relative of MANIFEST_PATHS) {
			const path = join(root, relative);
			const { text, changed } = syncVersion(readFileSync(path, "utf8"), version);
			if (changed) writeFileSync(path, text);
			console.log(`${relative}: ${version}${changed ? "" : " (already set)"}`);
		}
	} catch (error) {
		console.error(
			`sync-release-version: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}
