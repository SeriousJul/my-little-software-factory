#!/usr/bin/env bun
/**
 * Sync both package manifests to the version the release tag names.
 *
 * The tag is the one place the operator names a release (ADR 0090): the
 * operator cuts the tag from the GitHub interface and no local step is
 * allowed to move a manifest first. Every release job that reads or writes a
 * version runs this script before it acts, so the tree it builds, publishes,
 * and checks carries the tag's version.
 *
 * The script edits the two manifests in place:
 *   package.json                  the "version" field
 *   packages/mlsf/package.json    the "version" field and the exact pin on
 *                                 my-little-software-factory
 *
 * A manifest that already carries the version is left byte-identical, so a
 * re-run of a release job re-syncs nothing and commits nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The manifest paths, relative to the repository root. */
export const MANIFEST_PATHS = ["package.json", "packages/mlsf/package.json"];

/** The main package's name, the one the alias pins. */
const MAIN_PACKAGE = "my-little-software-factory";

export type Manifest = {
	version?: string;
	dependencies?: Record<string, string>;
	[key: string]: unknown;
};

/**
 * Write the version into one manifest's text.
 *
 * Returns the serialized manifest and whether any field moved. The
 * serialization keeps the manifest's key order and tab indent, so a
 * manifest that already carries the version comes back byte-identical.
 */
export function syncVersion(text: string, version: string): { text: string; changed: boolean } {
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`${version} is not a x.y.z version`);
	}
	const manifest = JSON.parse(text) as Manifest;
	let changed = manifest.version !== version;
	if (changed) manifest.version = version;
	const dependencies = manifest.dependencies;
	const pin = dependencies?.[MAIN_PACKAGE];
	if (dependencies && pin !== undefined && pin !== version) {
		dependencies[MAIN_PACKAGE] = version;
		changed = true;
	}
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
