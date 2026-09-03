/**
 * The command runner: the only exit of the control plane to the outside
 * world.
 *
 * Every external call (the herdr CLI, git, an agent CLI's model list) goes
 * through this interface: it executes a program with an argv and returns the
 * output, the exit status, and the error. It is the only injected test seam:
 * tests hand the app a fake runner that records the commands and returns
 * canned results, so the automated suite never calls a real herdr, agent
 * runtime, or ticket source.
 */
import { execFile } from "node:child_process";

import { firstNonEmptyLine } from "./lines.ts";

/** The result of one command: the exit status plus both streams. */
export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** One command, argv split, no shell. */
/** Environment values for one command. Values marked secret never become command facts. */
export interface CommandOptions {
	env?: Record<string, string>;
	secretEnv?: readonly string[];
	/**
	 * Kill this one command past this budget instead of the runner's own.
	 * A read-only query carries a shorter budget than a handoff: see
	 * `MODEL_LIST_TIMEOUT_MS`.
	 */
	timeoutMs?: number;
}

/**
 * The Model list an Agent runtime reports as available, or why it could not
 * be read. The runtime owns the set (ADR 0010): it lists only the models it
 * can actually run, so provider auth is already applied.
 */
export type ModelListResult = { ok: true; models: string[] } | { ok: false; reason: string };

export interface CommandRunner {
	run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
	/**
	 * The models the agent CLI of this kind offers, in the `provider/model`
	 * form its own `--model` option takes. It never throws: an unknown kind,
	 * a failed command, and an unreadable table all come back as a failure
	 * case with a readable reason.
	 */
	listModels(kind: string): Promise<ModelListResult>;
}

/**
 * One agent kind's Model list query: the command that prints the list, and
 * the reader of the table that command prints.
 */
export interface ModelListQuery {
	argv: readonly string[];
	parse: (stdout: string) => ModelListResult;
}

/**
 * The agent kinds whose own CLI reports a Model list (ADR 0010). Each entry
 * carries both halves of one kind's contract: a second kind brings its own
 * reader with its own command, so a table format cannot be applied to the
 * wrong CLI. A kind outside this map has no list: the override panel keeps its
 * free-text Model row, and the handoff fit check skips the model for it. A
 * declarative per-agent list command is the follow-up this map is built for.
 */
export const MODEL_LIST_COMMANDS: Readonly<Record<string, ModelListQuery>> = {
	pi: {
		argv: ["pi", "--list-models"],
		parse: (stdout) => parsePiModelList(stdout, "pi"),
	},
};

/** The Model list query of one agent kind, or undefined when it has none. */
export function modelListQuery(kind: string): ModelListQuery | undefined {
	return Object.hasOwn(MODEL_LIST_COMMANDS, kind) ? MODEL_LIST_COMMANDS[kind] : undefined;
}

/** True when the agent kind's CLI can report a Model list. */
export function supportsModelList(kind: string): boolean {
	return modelListQuery(kind) !== undefined;
}

/** Give a handoff command ten minutes; a handoff clones repositories. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Give a Model list query fifteen seconds, not the handoff's budget.
 *
 * The query is a read-only lookup the installed agent CLI answers in about
 * half a second, and it runs on paths where a long silence reads as a hung
 * control plane: before the first frame at boot, on every override panel open
 * and agent switch, and inside the observation cycle ahead of a handoff. An
 * agent CLI that starts but never answers must degrade to the no-list path
 * the callers already handle, and in seconds. A refused list is the designed
 * degrade; a hang is not.
 */
export const MODEL_LIST_TIMEOUT_MS = 15_000;
/** Command output stays small (herdr JSON, git status lines). */
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

/** The limits of the real runner; tests run real commands against small ones. */
export interface ChildProcessRunnerOptions {
	/** Kill a command that runs past this. Default: ten minutes. */
	timeoutMs?: number;
	/**
	 * Kill a Model list query that runs past this. Default:
	 * `MODEL_LIST_TIMEOUT_MS`.
	 */
	modelListTimeoutMs?: number;
	/** Fail a command that produces more output than this. Default: 10 MB. */
	maxBuffer?: number;
}

/**
 * The real runner: one child process per command through execFile.
 *
 * A program that cannot start (not installed, not in PATH), a command that
 * runs past the timeout, and a command that overflows the output buffer are
 * failed commands with a readable stderr, not thrown errors: the caller
 * reports the reason in the TUI.
 */
export function createChildProcessRunner(options: ChildProcessRunnerOptions = {}): CommandRunner {
	const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
	const modelListTimeoutMs = options.modelListTimeoutMs ?? MODEL_LIST_TIMEOUT_MS;
	const maxBuffer = options.maxBuffer ?? COMMAND_MAX_BUFFER;
	const runner: CommandRunner = {
		async run(command, args, options) {
			// A per-command budget lets a read-only query fail in its own time
			// while a handoff keeps its ten minutes.
			const budget = options?.timeoutMs ?? timeoutMs;
			try {
				const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
					(resolve, reject) => {
						execFile(
							command,
							[...args],
							{
								encoding: "utf8",
								timeout: budget,
								maxBuffer,
								env: options?.env === undefined ? process.env : { ...process.env, ...options.env },
							},
							(error, stdout, stderr) => {
								if (error && typeof error.code !== "number") {
									// A spawn-level failure (ENOENT, timeout,
									// buffer overflow), not a non-zero exit.
									reject(error);
								} else {
									resolve({
										code: typeof error?.code === "number" ? error.code : 0,
										stdout,
										stderr,
									});
								}
							},
						);
					},
				);
				return result;
			} catch (error) {
				return commandFailure(command, error, budget, maxBuffer);
			}
		},
		async listModels(kind) {
			return listModelsFor(runner, kind, modelListTimeoutMs);
		},
	};
	return runner;
}

/**
 * Query one agent kind's own CLI for its Model list (ADR 0010).
 *
 * The never-throw contract of `run` carries over: every failure comes back as
 * a reason the caller shows or degrades around. The query carries its own
 * short budget, so an agent CLI that never answers cannot hold the boot, the
 * override panel, or a handoff for the handoff's own ten minutes.
 */
async function listModelsFor(
	runner: CommandRunner,
	kind: string,
	timeoutMs: number,
): Promise<ModelListResult> {
	const query = modelListQuery(kind);
	if (query === undefined) {
		return { ok: false, reason: `the agent kind "${kind}" has no model list command` };
	}
	const [command, ...args] = query.argv;
	const result = await runner.run(command, args, { timeoutMs });
	if (result.code !== 0) {
		return {
			ok: false,
			reason: `${command} ${args.join(" ")} failed: ${commandFailureText(result)}`,
		};
	}
	return query.parse(result.stdout);
}

/** The fixed right-hand columns after the model: context, max-out, thinking, images. */
const PI_MODEL_TABLE_TRAILING = 4;
/** The least number of columns one `pi --list-models` row can hold. */
const PI_MODEL_TABLE_MIN_COLUMNS = PI_MODEL_TABLE_TRAILING + 2;

/**
 * The `pi --list-models` table, read from the right edge.
 *
 * The last four columns are fixed, so the model is the fifth column from the
 * end and the provider is everything before it. The value form is the
 * `provider/model` the pi `--model` option takes, which is what makes a model
 * id that already carries a slash (a GGUF repo path, for one) resolve to the
 * right provider.
 *
 * One value is one argument cell, and a table row that cannot honour that is
 * refused. A start command carries a model as one argv cell, and the panel's
 * type-ahead can only type letters, so a value with whitespace in it is a
 * value no handoff can carry and no operator can search for. Because the
 * parser reads a provider that spans two printed cells by joining them, that
 * rule is also what keeps a mis-read row from passing as a model: a provider
 * name never holds whitespace in a real table, so a row whose provider spans
 * cells is a layout the reader does not know.
 *
 * The table can sit behind a preamble: a tool manager announcing the version
 * it selected, or any other line the spawned program writes first. Every line
 * before the header is skipped, so that noise does not hide the list.
 *
 * The value form is what the installed runtime takes: `pi --model` splits a
 * pattern at the provider, so a provider whose name carries a URL and a model
 * id that carries a slash both resolve back to the same model they were
 * listed as.
 *
 * The shape is a pinned contract on the installed pi version. A layout change
 * is a failure case with a readable reason, which every caller degrades
 * around; it is never a crash and never a partial list.
 */
export function parsePiModelList(stdout: string, command = "pi"): ModelListResult {
	const models: string[] = [];
	let header = false;
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const columns = trimmed.split(/\s{2,}/);
		// Fifth from the end: the four columns after the model are fixed, and
		// the provider is everything before it.
		const at = columns.length - (PI_MODEL_TABLE_TRAILING + 1);
		const model = at >= 0 ? columns[at] : "";
		const provider = at >= 0 ? columns.slice(0, at).join("  ") : "";
		if (!header) {
			// Look for the header row wherever it sits, and skip whatever came
			// before it.
			if (provider === "provider" && model === "model") {
				header = true;
			}
			continue;
		}
		if (columns.length < PI_MODEL_TABLE_MIN_COLUMNS) {
			return unparseableModelTable(
				command,
				`a row holds ${columns.length} columns, not at least ${PI_MODEL_TABLE_MIN_COLUMNS}`,
			);
		}
		const value = `${provider}/${model}`;
		if (/\s/.test(value)) {
			// A provider that spans two printed cells, or a model the reader has
			// mis-cut: the value could never reach the agent as one argument cell,
			// so the whole table is refused rather than half-offered.
			return unparseableModelTable(command, `a row's model value holds whitespace (${value})`);
		}
		models.push(value);
	}
	if (!header) {
		return unparseableModelTable(command, "it printed no header row");
	}
	return { ok: true, models };
}

function unparseableModelTable(command: string, detail: string): ModelListResult {
	return {
		ok: false,
		reason: `${command} --list-models returned a table this version cannot read: ${detail}`,
	};
}

/** The first readable line of a failed command's output. */
export function commandFailureText(result: CommandResult): string {
	return firstNonEmptyLine(result.stderr) ?? `exit code ${result.code}`;
}

/** Map a spawn-level failure to a failed command with a readable reason. */
function commandFailure(
	command: string,
	error: unknown,
	timeoutMs: number,
	maxBuffer: number,
): CommandResult {
	const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
	if (err.code === "ENOENT") {
		return { code: 127, stdout: "", stderr: `${command} not found in PATH` };
	}
	if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
		// The buffer kill also sets err.killed on some node versions, so the
		// explicit code is checked before the timeout case. The two failures
		// read differently: one is output, the other is time.
		return {
			code: 125,
			stdout: "",
			stderr: `${command} output exceeded the ${maxBuffer}-byte buffer`,
		};
	}
	if (err.killed || err.signal) {
		return {
			code: 124,
			stdout: "",
			stderr: `${command} timed out after ${timeoutMs / 1000}s`,
		};
	}
	return { code: 1, stdout: "", stderr: String(err.message ?? error) };
}

/** One readable line for a thrown error, for the Message line. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
