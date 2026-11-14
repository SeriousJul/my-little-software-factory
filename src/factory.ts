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
import { createElement, createRoot } from "@opentui/react";

import { App } from "./components/app.ts";
import { createHerdrIdentityReporter } from "./herdr-identity.ts";
import { createRendererAdapter } from "./renderer-adapter.ts";
import { errorMessage } from "./runner.ts";
import { isSupportedBunVersion, unsupportedBunVersionMessage } from "./runtime.ts";
import { realSessionRecordLookup } from "./session-record.ts";
import { installStateShutdown, runStartup, startupArgs } from "./startup.ts";
import { factoryVersion } from "./version.ts";

if (!isSupportedBunVersion(Bun.version)) {
	process.stderr.write(unsupportedBunVersionMessage(Bun.version));
	process.exit(1);
}

const argv = process.argv.slice(2);
// `--version` is answered before any boot: the flag must work on a machine
// with no state, no herdr, and no config, which is the whole point of the
// prebuilt binary (ADR 0056).
const decision = startupArgs(argv);
if (decision.kind === "version") {
	process.stdout.write(`factory ${await factoryVersion()}\n`);
	process.exit(0);
}
if (decision.kind === "usage") {
	process.stderr.write(`${decision.reason}\n`);
	process.exit(1);
}
// The boot loads the paths this decision settled: the argument list is
// parsed once, here. The world path is the Stub run's (issue #178).
const startup = await runStartup(decision.configPath, decision.worldPath);
for (const line of startup.ok ? startup.notes : startup.lines) {
	process.stderr.write(`${line}\n`);
}
if (!startup.ok) {
	process.exit(startup.exitCode);
}
// The plane owns the terminal, so a crash that would print its stack there
// lands in the file record instead: the entry is the one place the process
// still has a console it must not touch.
process.on("uncaughtException", (error) => {
	startup.logger.error(`uncaught exception: ${errorMessage(error)}`);
	process.exit(1);
});
process.on("unhandledRejection", (reason) => {
	startup.logger.error(`unhandled rejection: ${errorMessage(reason)}`);
});

// The renderer adapter owns the renderer and the repaint policy (ADR
// 0145): it builds the renderer from the boot facts below, installs the
// frame callback that runs the policy, and returns the terminal on the
// run's shutdown. The entry keeps the private full-repaint request the
// policy sets out of reach, so the next screen change does not re-mark it.
//
// Ctrl+C is a documented emergency control. Keep it in the shared control
// catalogue instead of letting OpenTUI bypass the application.
// Ticket detail and Ticket list have direct wheel, click, and scrollbar
// controls. They need terminal mouse reporting, so this intentionally
// supersedes the old host-owned text-selection setting.
const adapter = await createRendererAdapter({
	rendererConfig: {
		exitOnCtrlC: false,
		useMouse: true,
		// Kitty keyboard names F13-F24, which the shared control catalogue
		// accepts for configurable Agent interaction exits.
		useKittyKeyboard: {},
	},
	// The blanket force (ADR 0145): the entry passes it on every frame
	// until a byte-loss signal exists, so the screen keeps its recorded
	// insurance against the drift class of OpenTUI issue 1187. When the
	// signal stands and a terminal walk verifies it, the entry withdraws
	// this fact and hands the signal to the adapter; the policy is
	// unchanged by the lift.
	blanketForce: () => true,
});
const renderer = adapter.renderer;
// Inside a herdr pane the plane gives herdr its own face before the first
// frame, so herdr's detection of this pane reads the report instead of the
// process it misreads as a pi agent in some screen states (issue #405,
// ADR 0139). Outside herdr the reporter stands inert.
const herdrIdentity = createHerdrIdentityReporter({
	env: process.env,
	runner: startup.runner,
	now: () => Date.now(),
	log: (line) => startup.logger.error(line),
});
// The watch restart of `bun run dev` and a plain `kill` end this run without
// running an exit hook, so the state lease would stay held by this process and
// the next boot would refuse to start. The decision of which endings close the
// state lives in the startup module; the entry only wires it up. It is wired
// here, once the renderer adapter exists, so the renderer puts the
// terminal back before the run ends. A run that dies before this line leaves a row whose pid
// is gone, which the next boot takes over.
// The app's teardown handle lands on the App's onReady once the mount runs,
// and the shutdown installer stops the app's background loops on every
// ending that closes the state. The holder keeps the handle where the
// installer reads it from, because the mount runs after the install. The
// installer's teardown gives the plane's herdr pane back when the run ends,
// by a release that carries its own sequence so it clears the boot report at
// once; a run herdr kills outright never reaches it, and on the installed
// herdr the unlanded report of such a run stands until the pane is reused,
// closed, or the herdr session restarts.
const appStop: { current: (() => void) | undefined } = { current: undefined };
installStateShutdown(startup.state, process, startup.logger, () => {
	appStop.current?.();
	adapter.destroy();
	herdrIdentity.release();
});
createRoot(renderer).render(
	createElement(App, {
		config: startup.config,
		runner: startup.runner,
		home: startup.home,
		configPath: startup.configPath,
		state: startup.state,
		sources: startup.sources,
		logger: startup.logger,
		agentHostResolution: startup.agentHost,
		agentHostMarks: startup.agentHostMarks,
		// The derived session record path on the host that reports none
		// (ADR 0144): the real lookup of the machine this run stands on.
		sessionRecord: realSessionRecordLookup,
		loopPolicy: { kind: "production" },
		// The plane's writes on the terminal outside the renderer (ADR
		// 0145): the bell on a Fault paints no cell, so it forces no
		// rewrite, and the adapter's policy reads the write as the fact it
		// is.
		reportOutsideTerminalWrite: (write) => adapter.reportOutsideTerminalWrite(write),
		onReady: (ready) => {
			appStop.current = ready.stop;
		},
	}),
);
