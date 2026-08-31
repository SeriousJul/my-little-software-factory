#!/usr/bin/env node
/** Boot the control plane after config, state, and source startup checks. */
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

const runner = createChildProcessRunner();
const sources = config.sources.map((source) => createTicketSource(source, runner));
const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(createElement(App, { config, runner, configPath, state, sources }));
