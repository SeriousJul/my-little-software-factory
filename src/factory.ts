#!/usr/bin/env node
/**
 * The control plane entry.
 *
 * This module is wiring only. It reads the argument list, runs the startup
 * decisions (src/startup.ts), prints the lines the result carries, and
 * either exits nonzero or starts the renderer. The operator-facing text and
 * the boot order are decided in the startup module, so a unit test reads
 * them as values without a process or a pseudo-terminal.
 */
import { createCliRenderer } from "@opentui/core";
import { createElement, createRoot } from "@opentui/react";

import { App } from "./components/app.ts";
import { isSupportedNodeVersion, MIN_NODE_VERSION } from "./runtime.ts";
import { runStartup } from "./startup.ts";

if (!isSupportedNodeVersion(process.versions.node)) {
	process.stderr.write(
		`factory needs Node ${MIN_NODE_VERSION} or newer, but this is Node ${process.versions.node}.\nThe project pins a supported Node in .tool-versions; run it through mise.\n`,
	);
	process.exit(1);
}

const startup = await runStartup(process.argv.slice(2));
for (const line of startup.ok ? startup.notes : startup.lines) {
	process.stderr.write(`${line}\n`);
}
if (!startup.ok) {
	process.exit(startup.exitCode);
}

process.on("exit", () => startup.state.close());

// Ctrl+C is a documented emergency control. Keep it in the shared control
// catalogue instead of letting OpenTUI bypass the application.
// Ticket detail and Ticket list have direct wheel, click, and scrollbar
// controls. They need terminal mouse reporting, so this intentionally
// supersedes the old host-owned text-selection setting.
const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true });
// The native renderer diffs each frame against its model of the screen and
// marks a model cell as written while it emits the cell's bytes. If the host
// terminal loses bytes of a frame, the model and the screen diverge and the
// later frames skip the lost cells, so stale fragments of an earlier frame
// linger until the next full repaint (anomalyco/opentui issue 1187). Force a
// full repaint every frame so any lost bytes are overwritten within one
// frame and the screen always converges to the model.
renderer.setFrameCallback(async () => {
	(renderer as unknown as { forceFullRepaintRequested?: boolean }).forceFullRepaintRequested = true;
});
createRoot(renderer).render(
	createElement(App, {
		config: startup.config,
		runner: startup.runner,
		configPath: startup.configPath,
		state: startup.state,
		sources: startup.sources,
	}),
);
