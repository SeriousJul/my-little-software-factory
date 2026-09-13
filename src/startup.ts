/**
 * The startup decisions.
 *
 * The entry (src/factory.ts) is wiring only: it reads `process.argv`, prints
 * whatever lines this module returns, and either exits or starts the
 * renderer. The decisions the boot makes - argument handling, the config
 * load, the model list check, and the state open - live here, where a unit
 * test imports the module and reads the result as a value instead of
 * starting a process or a pseudo-terminal. A startup failure is one of those
 * values: the operator-facing lines plus the exit status.
 *
 * The boot order is a contract (ADR 0010): load and structurally validate
 * the config, run the model validation, then open the state and the UI. A
 * config that names a model its agent cannot run stops the control plane
 * before it opens anything, so the operator fixes the file instead of losing
 * a ticket to an agent that dies inside its own terminal.
 */
import type { FactoryConfig } from "./config.ts";
import { ConfigError, defaultConfigPath, loadConfigFile, statePathFor } from "./config.ts";
import { validateConfiguredModels } from "./model-settings.ts";
import type { CommandRunner } from "./runner.ts";
import { createChildProcessRunner } from "./runner.ts";
import type { FactoryState } from "./state.ts";
import { openFactoryState, StateError } from "./state.ts";
import type { TicketSource } from "./ticket-source.ts";
import { createTicketSource } from "./ticket-source.ts";

/** The argument list, or the one usage line the operator reads instead. */
export type StartupArgsResult = { ok: true; configPath: string } | { ok: false; reason: string };

/** A loaded config, or the one failure line the operator reads instead. */
export type StartupConfigResult =
	| { ok: true; config: FactoryConfig; note?: string }
	| { ok: false; reason: string };

/** An opened state, or the one failure line the operator reads instead. */
export type StartupStateResult = { ok: true; state: FactoryState } | { ok: false; reason: string };

/**
 * The whole startup, as a value.
 *
 * A failure carries the lines to print to the operator, in the order they
 * are printed (warnings before the error they precede), and the exit status.
 * A success carries everything the entry needs to start the renderer and the
 * non-fatal lines (the missing-config note and the model warnings).
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
			/** Non-fatal operator lines: the missing-config note and model warnings. */
			notes: string[];
	  };

/**
 * The argument list: no argument is the shipped default path, and
 * `--config <path>` names one. Anything else is the usage line.
 */
export function configPathFromArgs(args: readonly string[]): StartupArgsResult {
	if (args.length === 0) return { ok: true, configPath: defaultConfigPath() };
	if (args.length === 2 && args[0] === "--config" && args[1] !== "")
		return { ok: true, configPath: args[1] };
	return { ok: false, reason: "usage: factory [--config <path>]" };
}

/**
 * Load and structurally validate the config at the given path. A missing
 * file is the shipped defaults with one note; an unreadable or invalid file
 * is one readable failure line.
 */
export async function loadStartupConfig(configPath: string): Promise<StartupConfigResult> {
	let loaded: { config: FactoryConfig; fromFile: boolean };
	try {
		loaded = await loadConfigFile(configPath);
	} catch (error) {
		if (error instanceof ConfigError) {
			return { ok: false, reason: error.message };
		}
		throw error;
	}
	return loaded.fromFile
		? { ok: true, config: loaded.config }
		: {
				ok: true,
				config: loaded.config,
				note: `no config file at ${configPath}, using the shipped defaults`,
			};
}

/**
 * Open the state database at the given path and take the one-process lease.
 * A path that cannot be opened is one readable failure line; the state is
 * left open only when it is usable.
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
	return { ok: true, state };
}

/**
 * The whole startup: the arguments, the config, the model list check, and
 * the state open, in the boot order.
 */
export async function runStartup(args: readonly string[]): Promise<StartupResult> {
	const parsed = configPathFromArgs(args);
	if (!parsed.ok) {
		return { ok: false, lines: [parsed.reason], exitCode: 1 };
	}

	const loaded = await loadStartupConfig(parsed.configPath);
	if (!loaded.ok) {
		return { ok: false, lines: [loaded.reason], exitCode: 1 };
	}

	const notes: string[] = [];
	if (loaded.note !== undefined) notes.push(loaded.note);

	const runner = createChildProcessRunner();
	// The config's model values, checked against what the agent runtimes
	// actually offer. An unavailable list only warns: one agent kind that
	// cannot answer must not block the control plane.
	const models = await validateConfiguredModels(loaded.config, runner);
	for (const warning of models.warnings) {
		notes.push(`warning: ${warning}`);
	}
	if (models.errors.length > 0) {
		return { ok: false, lines: [...notes, ...models.errors], exitCode: 1 };
	}

	const statePath = statePathFor(loaded.config, parsed.configPath);
	const opened = openStartupState(statePath);
	if (!opened.ok) {
		return { ok: false, lines: [opened.reason], exitCode: 1 };
	}

	const sources = loaded.config.sources.map((source) => createTicketSource(source, runner));
	return {
		ok: true,
		config: loaded.config,
		configPath: parsed.configPath,
		statePath,
		state: opened.state,
		runner,
		sources,
		notes,
	};
}
