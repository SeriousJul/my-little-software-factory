#!/usr/bin/env node
/**
 * The control plane entry module. Boots the OpenTUI renderer and mounts the
 * app. Plain TypeScript, no build step: node strips the types and runs this
 * directly.
 */
import { createCliRenderer } from "@opentui/core";
import { createElement, createRoot } from "@opentui/react";

import { App } from "./components/app.ts";
import { isSupportedNodeVersion, MIN_NODE_VERSION } from "./runtime.ts";

// The OpenTUI native renderer needs node 26.4 or newer. Fail with an
// actionable message instead of a cryptic FFI error on an older runtime.
if (!isSupportedNodeVersion(process.versions.node)) {
	process.stderr.write(
		`factory needs Node ${MIN_NODE_VERSION} or newer, but this is Node ${process.versions.node}.\n` +
			`The project pins a supported Node in .tool-versions; run it through mise.\n`,
	);
	process.exit(1);
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(createElement(App));
