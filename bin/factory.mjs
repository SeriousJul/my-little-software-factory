#!/usr/bin/env bun
/**
 * Standalone bin wrapper for the control plane.
 *
 * Bun's FFI is stable and built in, so no flag and no re-spawn is needed: the
 * wrapper checks the Bun floor before the production entry (which loads the
 * OpenTUI native core) and then runs that entry in the same process. A Bun
 * below the floor gets the required version and the reason, not a native
 * crash.
 */
import { isSupportedBunVersion, unsupportedBunVersionMessage } from "../src/runtime-support.mjs";

if (!isSupportedBunVersion(Bun.version)) {
	process.stderr.write(unsupportedBunVersionMessage(Bun.version));
	process.exit(1);
}

await import("../src/factory.ts");
