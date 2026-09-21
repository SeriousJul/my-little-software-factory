/**
 * The runtime requirement, re-exported from the plain-JS helper.
 *
 * The helper lives in src/runtime-support.mjs so the bin wrapper can load it
 * on the Bun versions it refuses; this module keeps the TypeScript surface the
 * app and the tests import.
 */
export {
	compareVersions,
	isSupportedBunVersion,
	MIN_BUN_VERSION,
	unsupportedBunVersionMessage,
} from "./runtime-support.mjs";
