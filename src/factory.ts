#!/usr/bin/env node
/**
 * The control plane entry module. Boots the OpenTUI renderer and mounts the
 * app. Plain TypeScript, no build step: node strips the types and runs this
 * directly.
 */
import { createCliRenderer } from "@opentui/core";
import { createElement, createRoot } from "@opentui/react";
import { App } from "./components/app.ts";
import { ConfigError, defaultConfigPath, type FactoryConfig, loadConfigFile } from "./config.ts";
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

// The config is read and validated before the UI starts. A missing file
// yields the shipped defaults, and the start says so before the UI takes
// over, so the operator knows where to put a file. An invalid file stops
// the control plane with a readable error, so a wrong flag surfaces before
// any handoff.
const configPath = defaultConfigPath();
let config: FactoryConfig;
try {
	const loaded = loadConfigFile(configPath);
	if (!loaded.fromFile) {
		process.stderr.write(`no config file at ${configPath}, using the shipped defaults\n`);
	}
	config = loaded.config;
} catch (error) {
	if (error instanceof ConfigError) {
		process.stderr.write(`${error.message}\n`);
		process.exit(1);
	}
	throw error;
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(createElement(App, { config }));
