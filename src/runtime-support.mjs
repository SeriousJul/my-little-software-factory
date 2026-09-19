/**
 * The runtime requirement.
 *
 * The OpenTUI native renderer is reached through the runtime's foreign
 * function interface. On Bun that interface is the stable, built-in `bun:ffi`
 * module, so the renderer needs no flag, but it still needs a Bun new enough
 * to ship that module and the matching native core artifact. OpenTUI 0.5
 * requires Bun 1.3.0 or newer; native Windows arm64 needs 1.4.0 because Bun
 * 1.3 has no FFI there. Failing at startup with an actionable message beats
 * a native crash on an older runtime.
 *
 * This file is plain JavaScript on purpose: the bin wrapper loads it before
 * the production entry (which pulls in the OpenTUI native core), so it must
 * parse on the runtimes it refuses. src/runtime.ts re-exports it, and the unit
 * tests pin it from there.
 */

export const MIN_BUN_VERSION = "1.3.0";

/** Compare two dotted versions. Returns -1, 0, or 1. */
export function compareVersions(a, b) {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < 3; i += 1) {
		const da = Number.parseInt(pa[i] ?? "0", 10) || 0;
		const db = Number.parseInt(pb[i] ?? "0", 10) || 0;
		if (da < db) return -1;
		if (da > db) return 1;
	}
	return 0;
}

/** Whether a Bun version can run the factory. */
export function isSupportedBunVersion(version) {
	return compareVersions(version, MIN_BUN_VERSION) >= 0;
}

/**
 * The operator-facing text for a Bun below the floor: the required version
 * and the reason, so the operator fixes the environment instead of reading
 * a native crash.
 */
export function unsupportedBunVersionMessage(actual) {
	return (
		`factory needs Bun ${MIN_BUN_VERSION} or newer, but this is Bun ${actual}.\n` +
		`The OpenTUI renderer loads the native core through Bun's FFI, which needs Bun ${MIN_BUN_VERSION} or newer.\n` +
		`Install Bun ${MIN_BUN_VERSION} or newer and start again.\n`
	);
}
