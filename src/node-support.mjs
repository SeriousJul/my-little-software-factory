/**
 * The runtime requirement.
 *
 * The OpenTUI native renderer loads node:ffi, and node gates it behind
 * --experimental-ffi. OpenTUI 0.5.9 requires node 26.4 or newer, so the
 * factory starts only there or later. Failing at startup with an actionable
 * message beats a cryptic FFI error on an older runtime.
 *
 * This file is plain JavaScript on purpose: the bin wrapper must load it on
 * exactly the Node versions it refuses, and those cannot load TypeScript.
 * src/runtime.ts re-exports it, and the unit tests pin it from there.
 */

export const MIN_NODE_VERSION = "26.4.0";

/** Compare two dotted versions. Returns -1, 0, or 1. */
export function compareVersions(a, b) {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < 3; i += 1) {
		const da = Number.parseInt(pa[i] ?? "0", 10) || 0;
		const db = Number.parseInt(pb[i] ?? "0", 10) || 0;
		if (da < db) {
			return -1;
		}
		if (da > db) {
			return 1;
		}
	}
	return 0;
}

/** Whether a node version can run the factory. */
export function isSupportedNodeVersion(version) {
	return compareVersions(version, MIN_NODE_VERSION) >= 0;
}

/**
 * The operator-facing text for a Node below the floor: the required version
 * and the reason, so the operator fixes the environment instead of reading
 * a stack trace.
 */
export function unsupportedNodeVersionMessage(actual) {
	return (
		`factory needs Node ${MIN_NODE_VERSION} or newer, but this is Node ${actual}.\n` +
		`The OpenTUI renderer loads node:ffi, which needs Node ${MIN_NODE_VERSION} or newer.\n` +
		`Install Node ${MIN_NODE_VERSION} or newer and start again.\n`
	);
}
