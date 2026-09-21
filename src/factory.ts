#!/usr/bin/env bun
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
import { isSupportedBunVersion, unsupportedBunVersionMessage } from "./runtime.ts";
import { installStateShutdown, runStartup } from "./startup.ts";

if (!isSupportedBunVersion(Bun.version)) {
	process.stderr.write(unsupportedBunVersionMessage(Bun.version));
	process.exit(1);
}

const startup = await runStartup(process.argv.slice(2));
for (const line of startup.ok ? startup.notes : startup.lines) {
	process.stderr.write(`${line}\n`);
}
if (!startup.ok) {
	process.exit(startup.exitCode);
}

// Ctrl+C is a documented emergency control. Keep it in the shared control
// catalogue instead of letting OpenTUI bypass the application.
// Ticket detail and Ticket list have direct wheel, click, and scrollbar
// controls. They need terminal mouse reporting, so this intentionally
// supersedes the old host-owned text-selection setting.
const renderer = await createCliRenderer({
	exitOnCtrlC: false,
	useMouse: true,
	// Kitty keyboard names F13-F24, which the shared control catalogue accepts
	// for configurable Agent interaction exits.
	useKittyKeyboard: {},
});
// The watch restart of `bun run dev` and a plain `kill` end this run without
// running an exit hook, so the state lease would stay held by this process and
// the next boot would refuse to start. The decision of which endings close the
// state lives in the startup module; the entry only wires it up. It is wired
// here, once the renderer exists, so the renderer puts the terminal back
// before the run ends. A run that dies before this line leaves a row whose pid
// is gone, which the next boot takes over.
installStateShutdown(startup.state);
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
