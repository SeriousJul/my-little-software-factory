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
import { handoffStartFailedLine } from "./domain/attempt-record.ts";
import { recordTicketName } from "./domain/record-name.ts";
import { createLogger, type Logger, NOOP_LOGGER } from "./logging.ts";
import { validateConfiguredModels } from "./model-settings.ts";
import type { CommandRunner } from "./runner.ts";
import { createChildProcessRunner } from "./runner.ts";
import type { HandoffSettlement } from "./state/handoff.ts";
import { type FactoryState, openFactoryState, StateError } from "./state.ts";
import { createStubRunner } from "./stub/runner.ts";
import { StubWorldError, StubWorldStore } from "./stub/world.ts";
import type { TicketSource } from "./ticket-source.ts";
import { createTicketSource } from "./ticket-source.ts";

/**
 * The argument list, or the one usage line the operator reads instead.
 * The `worldPath` is the Stub run's world file (issue #178, ADR 0073): the
 * startup wiring learns that a stub is in play through this one flag beside
 * the config path, and no other module learns it.
 */
export type StartupArgsResult =
	| { ok: true; configPath: string; worldPath?: string }
	| { ok: false; reason: string };

/**
 * The argument list as a decision: run the plane on a config path, print the
 * plane's version, or show the usage line.
 */
export type StartupDecision =
	| { kind: "run"; configPath: string; worldPath?: string }
	| { kind: "version" }
	| { kind: "usage"; reason: string };

/** A loaded config, or the one failure line the operator reads instead. */
export type StartupConfigResult =
	| { ok: true; config: FactoryConfig; note?: string }
	| { ok: false; reason: string };

/** An opened state, or the one failure line the operator reads instead. */
export type StartupStateResult =
	| { ok: true; state: FactoryState; notes: string[]; recovered: HandoffSettlement[] }
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
export const USAGE = "usage: factory [--config <path>] [--world <path>] | factory --version";

/**
 * The argument list: no argument is the shipped default path, `--config
 * <path>` names one, and `--world <path>` names the Stub run's world file. A
 * flag without a value, a repeated flag, or anything else is the usage line.
 */
export function configPathFromArgs(args: readonly string[]): StartupArgsResult {
	const state: StartupArgState = { configPath: undefined, worldPath: undefined };
	for (let i = 0; i < args.length; i += 1) {
		const step = startupArgStep(args, i, state);
		if (!step.ok) return { ok: false, reason: USAGE };
		i += step.advance;
	}
	return {
		ok: true,
		configPath: state.configPath ?? defaultConfigPath(),
		...(state.worldPath !== undefined ? { worldPath: state.worldPath } : {}),
	};
}

/** The config and world paths the argument list holds. */
interface StartupArgState {
	configPath: string | undefined;
	worldPath: string | undefined;
}

/**
 * The one argument of the startup list, written into the state, or the
 * refusal the argument earns: an unknown argument, a flag without a value,
 * or a flag the list already holds.
 */
function startupArgStep(
	args: readonly string[],
	i: number,
	state: StartupArgState,
): { ok: boolean; advance: number } {
	const arg = args[i];
	if (arg !== "--config" && arg !== "--world") return { ok: false, advance: 0 };
	const value = args[i + 1];
	if (value === undefined || value === "") return { ok: false, advance: 0 };
	if (arg === "--config") {
		if (state.configPath !== undefined) return { ok: false, advance: 0 };
		state.configPath = value;
		return { ok: true, advance: 1 };
	}
	if (state.worldPath !== undefined) return { ok: false, advance: 0 };
	state.worldPath = value;
	return { ok: true, advance: 1 };
}

/**
 * The argument list as a decision: `--version` prints the plane's version
 * (the entry answers it before any boot), and every other list is the config
 * path, the world path, or the usage line.
 */
export function startupArgs(args: readonly string[]): StartupDecision {
	if (args.length === 1 && args[0] === "--version") return { kind: "version" };
	const parsed = configPathFromArgs(args);
	if (parsed.ok)
		return {
			kind: "run",
			configPath: parsed.configPath,
			...(parsed.worldPath !== undefined ? { worldPath: parsed.worldPath } : {}),
		};
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
		};
	}
	return {
		ok: true,
		config: loaded.config,
	};
}

/**
 * Open the state database at the given path, take the one-process lease, and
 * settle the handoff claims the previous run left unsettled (ADR 0041).
 * A path that cannot be opened is one readable failure line; the state is
 * left open only when it is usable. A recovered claim is a note, not a
 * warning: the recovery is the normal end of the crashed run's start, and
 * the ticket it frees is ready to hand off again. The settled records come
 * back beside the note so the boot can state each one in the record the run
 * writes to (issue #295).
 */
export function openStartupState(statePath: string): StartupStateResult {
	let state: FactoryState | undefined;
	try {
		state = openFactoryState(statePath);
		state.lease.acquireLease();
	} catch (error) {
		if (state !== undefined) state.close();
		const message = error instanceof StateError ? error.message : String(error);
		return { ok: false, reason: message };
	}
	const recovered = state.handoff.recoverUnsettledHandoffs();
	return {
		ok: true,
		state,
		recovered,
		notes:
			recovered.length === 0
				? []
				: [
						`recovered ${recovered.length} handoff claim${recovered.length === 1 ? "" : "s"} left unsettled by the previous run`,
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
 * The runner the boot runs on: the stub world on the real runner when the
 * flag names one (issue #178, ADR 0073). The stub runner serves only the
 * `gh` commands from the world and passes every other command to the real
 * binaries. A world file that cannot be read is the boot's refusal.
 */
function stubRunnerGate(
	realRunner: CommandRunner,
	worldPath: string | undefined,
	notes: string[],
): { ok: true; runner: CommandRunner } | { ok: false; reason: string } {
	if (worldPath === undefined) return { ok: true, runner: realRunner };
	let world: StubWorldStore;
	try {
		world = StubWorldStore.load(worldPath);
	} catch (error) {
		const reason =
			error instanceof StubWorldError
				? error.message
				: `the stub world could not be loaded: ${String(error)}`;
		return { ok: false, reason };
	}
	notes.push(`the stub world answers the GitHub commands from ${worldPath}`);
	return { ok: true, runner: createStubRunner(realRunner, world) };
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
export async function runStartup(configPath: string, worldPath?: string): Promise<StartupResult> {
	const loaded = await loadStartupConfig(configPath);
	if (!loaded.ok) {
		return { ok: false, lines: [loaded.reason], exitCode: 1 };
	}

	const notes: string[] = [];
	if (loaded.note !== undefined) notes.push(loaded.note);

	const statePath = statePathFor(loaded.config, configPath);
	const logger = startupLogger(loaded.config, configPath);
	const stub = stubRunnerGate(createChildProcessRunner(), worldPath, notes);
	if (!stub.ok) {
		logger.error(`startup failed: ${stub.reason}`);
		return { ok: false, lines: [...notes, stub.reason], exitCode: 1 };
	}
	const runner = stub.runner;
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
	// A claim the previous run left unsettled settles `failed` at the open
	// (ADR 0041), and that attempt is a start the factory made that never reached
	// its Agent. The dead run wrote its `handoff started:` line and nothing after
	// it, so this boot states the ending beside it: the record for one Ticket then
	// answers how many starts were made and why each one ended (issue #295).
	//
	// The names come off one projection read (ADR 0093): the stored rows are the
	// last titles the sources left in the state file, since the run that starts
	// has fetched nothing yet and the starts these lines name belong to the run
	// that ended. The name rule is the shared one, so the boot names a Ticket the
	// way the dispatch named it in the line the dead run wrote (issue #295 review).
	if (opened.recovered.length > 0) {
		const projection = opened.state.ticketWorkCycle.ticketProjection(
			loaded.config.workflowStates,
			loaded.config.defaultTaskType,
		);
		for (const attempt of opened.recovered) {
			logger.warn(
				handoffStartFailedLine(
					recordTicketName(projection, attempt.ticketIdentity),
					attempt.failureReason,
				),
			);
		}
	}

	const sources = loaded.config.sources.map((source) => createTicketSource(source, runner));
	logger.info(
		`boot: bun ${typeof Bun !== "undefined" ? Bun.version : "unknown"}, config ${configPath}, world ${worldPath ?? "none"}, state ${statePath}, sources ${sources.length}`,
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
