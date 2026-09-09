#!/usr/bin/env node
/**
 * Run the shared control gallery.
 *
 * This is the same renderer, the same keyboard, and the same production control
 * modules the control plane runs, so what a contributor sees here is what the
 * application draws: a gallery that imitated the controls would test nothing,
 * and the standard says it must not.
 *
 * The gallery reads no config file, opens no state, and starts no Agent. It is a
 * control-plane surface only, and it leaves the terminal the way it found it.
 */
import { createCliRenderer } from "@opentui/core";
import { createElement, createRoot } from "@opentui/react";

import { Gallery } from "./components/shared/gallery.ts";
import { isSupportedNodeVersion, MIN_NODE_VERSION } from "./runtime.ts";

if (!isSupportedNodeVersion(process.versions.node)) {
	process.stderr.write(
		`factory needs Node ${MIN_NODE_VERSION} or newer, but this is Node ${process.versions.node}.\nThe project pins a supported Node in .tool-versions; run it through mise.\n`,
	);
	process.exit(1);
}

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(
	createElement(Gallery, {
		// `factory-gallery <example>` opens on one state, so a review can jump
		// straight to the example it is checking.
		example: process.argv[2],
		onEmergencyExit: () => renderer.destroy(),
	}),
);
