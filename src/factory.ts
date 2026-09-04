#!/usr/bin/env node
/**
 * Boot the control plane.
 *
 * The boot order is a contract: load and structurally validate the config,
 * create the runner, run the model validation, then open the state and the
 * UI. A config that names a model its agent cannot run stops the control
 * plane before it opens anything, so the operator fixes the file instead of
 * losing a ticket to an agent that dies inside its own terminal (ADR 0010).
 */
import { createCliRenderer } from "@opentui/core";
import { createElement, createRoot } from "@opentui/react";

import { App } from "./components/app.ts";
import {
	ConfigError,
	defaultConfigPath,
	type FactoryConfig,
	loadConfigFile,
	statePathFor,
} from "./config.ts";
import { validateConfiguredModels } from "./model-settings.ts";
import { createChildProcessRunner } from "./runner.ts";
import { isSupportedNodeVersion, MIN_NODE_VERSION } from "./runtime.ts";
import { type FactoryState, openFactoryState, StateError } from "./state.ts";
import { createTicketSource } from "./ticket-source.ts";

if (!isSupportedNodeVersion(process.versions.node)) {
	process.stderr.write(
		`factory needs Node ${MIN_NODE_VERSION} or newer, but this is Node ${process.versions.node}.\nThe project pins a supported Node in .tool-versions; run it through mise.\n`,
	);
	process.exit(1);
}

function configPathFromArgs(args: readonly string[]): string {
	if (args.length === 0) return defaultConfigPath();
	if (args.length === 2 && args[0] === "--config" && args[1] !== "") return args[1];
	throw new ConfigError("usage: factory [--config <path>]");
}

let configPath: string;
try {
	configPath = configPathFromArgs(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

let config: FactoryConfig;
try {
	const loaded = await loadConfigFile(configPath);
	if (!loaded.fromFile)
		process.stderr.write(`no config file at ${configPath}, using the shipped defaults\n`);
	config = loaded.config;
} catch (error) {
	if (error instanceof ConfigError) {
		process.stderr.write(`${error.message}\n`);
		process.exit(1);
	}
	throw error;
}

const runner = createChildProcessRunner();

// The config's model values, checked against what the agent runtimes actually
// offer. An unavailable list only warns: one agent kind that cannot answer
// must not block the control plane.
const models = await validateConfiguredModels(config, runner);
for (const warning of models.warnings) {
	process.stderr.write(`warning: ${warning}\n`);
}
if (models.errors.length > 0) {
	for (const error of models.errors) process.stderr.write(`${error}\n`);
	process.exit(1);
}

let state: FactoryState;
try {
	state = openFactoryState(statePathFor(config, configPath));
	state.acquireLease();
} catch (error) {
	const message = error instanceof StateError ? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
process.on("exit", () => state.close());

const sources = config.sources.map((source) => createTicketSource(source, runner));
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
createRoot(renderer).render(createElement(App, { config, runner, configPath, state, sources }));
