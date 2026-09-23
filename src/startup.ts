/**
 * The startup decisions.
 *
 * The entry (src/factory.ts) is wiring only: it reads `process.argv`, prints
 * whatever lines this module returns, and either exits or starts the
 * renderer. The decisions the boot makes - argument handling, the config
 * load, the model list check, and the state open - live here, where a unit
 * test imports the module and reads the result as a value instead of
 * starting a process or a pseudo-terminal. A startup failure is one of those
 * values: the operator-facing lines plus the exit status. The module also
 * owns the shutdown install: which process endings close the state, so a test
 * attaches it to a recorder instead of to a real signal.
 *
 * The boot order is a contract (ADR 0010): load and structurally validate
 * the config, run the model validation, then open the state and the UI. A
 * config that names a model its agent cannot run stops the control plane
 * before it opens anything, so the operator fixes the file instead of losing
 * a ticket to an agent that dies inside its own terminal.
 */
import type { FactoryConfig } from "./config.ts";
import {
	ConfigError,
	defaultConfigPath,
	type LoadedConfig,
	loadConfigFile,
	logPathFor,
	statePathFor,
} from "./config.ts";
import { createLogger, type Logger, NOOP_LOGGER } from "./logging.ts";
import { validateConfiguredModels } from "./model-settings.ts";
import type { CommandRunner } from "./runner.ts";
import { createChildProcessRunner } from "./runner.ts";
import type { FactoryState } from "./state.ts";
import { openFactoryState, StateError } from "./state.ts";
import type { TicketSource } from "./ticket-source.ts";
import { createTicketSource } from "./ticket-source.ts";

/** The argument list, or the one usage line the operator reads instead. */
export type StartupArgsResult = { ok: true; configPath: string } | { ok: false; reason: string };

/**
 * The argument list as a decision: run the plane on a config path, print the
 * plane's version, or show the usage line.
 */
export type StartupDecision =
	| { kind: "run"; configPath: string }
	| { kind: "version" }
	| { kind: "usage"; reason: string };

/** A loaded config, or the one failure line the operator reads instead. */
export type StartupConfigResult =
	| { ok: true; config: FactoryConfig; note?: string; warnings: string[] }
	| { ok: false; reason: string };

/** An opened state, or the one failure line the operator reads instead. */
export type StartupStateResult =
	| { ok: true; state: FactoryState; notes: string[] }
	| { ok: false; reason: string };

/**
 * The whole startup, as a value.
 *
 * A failure carries the lines to print to the operator, in the order they
 * are printed (warnings before the error they precede), and the exit status.
 * A success carries everything the entry needs to start the renderer and the
 * non-fatal lines (the missing-config note and the model warnings). The
 * logger is created as soon as the config can be read, so a boot that fails
 * later still leaves its failure in the record the run writes to.
 */
export type StartupResult =
	| { ok: false; lines: string[]; exitCode: number }
	| {
			ok: true;
			config: FactoryConfig;
			configPath: string;
			statePath: string;
			state: FactoryState;
			runner: CommandRunner;
			sources: TicketSource[];
			/** The plane's file logger; the no-op logger where the config carries no [logging]. */
			logger: Logger;
			/** Non-fatal operator lines: the missing-config note and model warnings. */
			notes: string[];
	  };

/**
 * The logger the boot resolves from the loaded config: the [logging] level
 * and rotation into the file the section names, or the no-op logger where
 * the section is absent, the state of a config seeded before logging.
 */
export function startupLogger(config: FactoryConfig, configPath: string): Logger {
	if (config.logging === undefined) return NOOP_LOGGER;
	const file = logPathFor(config, configPath);
	if (file === undefined) return NOOP_LOGGER;
	return createLogger({
		level: config.logging.level,
		file,
		maxSizeBytes: config.logging.maxSizeMib * 1024 * 1024,
		keep: config.logging.keep,
	});
}

/** The usage line the argument handling shows for anything it does not take. */
export const USAGE = "usage: factory [--config <path>] | factory --version";

/**
 * The argument list: no argument is the shipped default path, and
 * `--config <path>` names one. Anything else is the usage line.
 */
export function configPathFromArgs(args: readonly string[]): StartupArgsResult {
	if (args.length === 0) return { ok: true, configPath: defaultConfigPath() };
	if (args.length === 2 && args[0] === "--config" && args[1] !== "")
		return { ok: true, configPath: args[1] };
	return { ok: false, reason: USAGE };
}

/**
 * The argument list as a decision: `--version` prints the plane's version
 * (the entry answers it before any boot), and every other list is the config
 * path or the usage line.
 */
export function startupArgs(args: readonly string[]): StartupDecision {
	if (args.length === 1 && args[0] === "--version") return { kind: "version" };
	const parsed = configPathFromArgs(args);
	if (parsed.ok) return { kind: "run", configPath: parsed.configPath };
	return { kind: "usage", reason: parsed.reason };
}

/**
 * Load and structurally validate the config at the given path. A missing
 * file is seeded from the Default configuration the package ships, with one
 * note; an unreadable or invalid file is one readable failure line.
 */
export async function loadStartupConfig(configPath: string): Promise<StartupConfigResult> {
	let loaded: LoadedConfig;
	try {
		loaded = await loadConfigFile(configPath);
	} catch (error) {
		if (error instanceof ConfigError) {
			return { ok: false, reason: error.message };
		}
		throw error;
	}
	if (loaded.seeded) {
		return {
			ok: true,
			config: loaded.config,
			note: `no config file at ${configPath}; created it from the shipped Default configuration`,
			warnings: loaded.warnings,
		};
	}
	return {
		ok: true,
		config: loaded.config,
		warnings: loaded.warnings,
	};
}

/**
 * Open the state database at the given path, take the one-process lease, and
 * settle the handoff claims the previous run left unsettled (ADR 0041).
 * A path that cannot be opened is one readable failure line; the state is
 * left open only when it is usable. A recovered claim is a note, not a
 * warning: the recovery is the normal end of the crashed run's start, and
 * the ticket it frees is ready to hand off again.
 */
export function openStartupState(statePath: string): StartupStateResult {
	let state: FactoryState | undefined;
	try {
		state = openFactoryState(statePath);
		state.acquireLease();
	} catch (error) {
		if (state !== undefined) state.close();
		const message = error instanceof StateError ? error.message : String(error);
		return { ok: false, reason: message };
	}
	const recovered = state.recoverUnsettledHandoffs();
	return {
		ok: true,
		state,
		notes:
			recovered === 0
				? []
				: [
						`recovered ${recovered} handoff claim${recovered === 1 ? "" : "s"} left unsettled by the previous run`,
					],
	};
}

/**
 * The process the shutdown attaches to: the hooks it writes, and the exit it
 * asks for. The entry passes the real process; a test passes a recorder.
 */
export interface ShutdownProcess {
	on(signal: string, listener: () => void): unknown;
	exit(code?: number): void;
}

/**
 * Close the state when the run ends, on every path that ends it.
 *
 * The exit hook covers the clean end: the operator quits, the renderer goes
 * away, the process exits. It is not enough on its own for two paths that end
 * a run without running an exit hook:
 *
 * - A `kill` with no signal listener ends the run by the default action. The
 *   lease then stays held in the state file, and the journal stays unfolded in
 *   the WAL sidecar.
 * - `bun run dev` restarts the entry inside the same process. The watch reset
 *   delivers SIGTERM to the live run, runs no exit hook, and re-runs the boot
 *   with the same pid, so the lease row the reset leaves behind names the next
 *   boot's own process: that boot reads "state database is already in use" and
 *   stops before it draws anything.
 *
 * So SIGTERM and SIGHUP close the state too, then ask for the exit: a run that
 * installs this stays stoppable by `kill`. The close is idempotent, so the
 * signal path and the exit hook together still close once.
 *
 * Install it after the renderer exists. The renderer listens for the same
 * signals to put the terminal back, and a run ends its listeners in the order
 * they were written, so the terminal comes back before the exit.
 */
export function installStateShutdown(
	state: FactoryState,
	target: ShutdownProcess = process,
	logger?: Logger,
): void {
	const terminate = () => {
		state.close();
		target.exit(0);
	};
	// The exit hook is the one path every ending takes, so the run-ended line
	// lands here once: terminate's exit(0) fires the hook, and a clean quit
	// runs it directly.
	target.on("exit", () => {
		logger?.info("run ended");
		state.close();
	});
	target.on("SIGTERM", terminate);
	target.on("SIGHUP", terminate);
}

/**
 * The whole startup: the config, the model list check, and the state open,
 * in the boot order.
 *
 * It takes the config path the argument decision already settled
 * (`startupArgs`): one list, one parser, so the path the entry acts on and
 * the path the boot loads cannot drift. A usage line stays the argument
 * decision's answer, not a second parse in here.
 */
export async function runStartup(configPath: string): Promise<StartupResult> {
	const loaded = await loadStartupConfig(configPath);
	if (!loaded.ok) {
		return { ok: false, lines: [loaded.reason], exitCode: 1 };
	}

	const notes: string[] = [];
	if (loaded.note !== undefined) notes.push(loaded.note);
	// The config's non-blocking issues: the Priority section reports here
	// and the factory starts with no ranking, the way a missing model list
	// only warns (ADR 0022).
	for (const warning of loaded.warnings) {
		notes.push(`warning: ${warning}`);
	}

	const statePath = statePathFor(loaded.config, configPath);
	const logger = startupLogger(loaded.config, configPath);
	const runner = createChildProcessRunner();
	// The config's model values, checked against what the agent runtimes
	// actually offer. An unavailable list only warns: one agent kind that
	// cannot answer must not block the control plane.
	const models = await validateConfiguredModels(loaded.config, runner);
	for (const warning of models.warnings) {
		notes.push(`warning: ${warning}`);
		logger.warn(warning);
	}
	if (models.errors.length > 0) {
		for (const error of models.errors) logger.error(`startup failed: ${error}`);
		return { ok: false, lines: [...notes, ...models.errors], exitCode: 1 };
	}

	const opened = openStartupState(statePath);
	if (!opened.ok) {
		// The warnings precede the failure they lead to.
		logger.error(`startup failed: ${opened.reason}`);
		return { ok: false, lines: [...notes, opened.reason], exitCode: 1 };
	}
	// The recovery note lands after the warnings: it is the last of the boot's
	// findings, and the state it opens already carries the repair.
	for (const note of opened.notes) notes.push(note);

	const sources = loaded.config.sources.map((source) => createTicketSource(source, runner));
	logger.info(
		`boot: bun ${typeof Bun !== "undefined" ? Bun.version : "unknown"}, config ${configPath}, state ${statePath}, sources ${sources.length}`,
	);
	return {
		ok: true,
		config: loaded.config,
		configPath,
		statePath,
		state: opened.state,
		runner,
		sources,
		logger,
		notes,
	};
}
