/**
 * The runtime requirement, re-exported from the plain-JS helper.
 *
 * The helper lives in src/node-support.mjs so the bin wrapper can load it on
 * the Node versions it refuses; this module keeps the TypeScript surface the
 * app and the tests import.
 */
export {
	compareVersions,
	isSupportedNodeVersion,
	MIN_NODE_VERSION,
	unsupportedNodeVersionMessage,
} from "./node-support.mjs";
