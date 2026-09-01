/**
 * The command runner: the only exit of the control plane to the outside
 * world.
 *
 * Every external call (the herdr CLI, git) goes through this interface: it
 * executes a program with an argv and returns the output, the exit status,
 * and the error. It is the only injected test seam: tests hand the app a
 * fake runner that records the commands and returns canned results, so the
 * automated suite never calls a real herdr.
 */
import { execFile } from "node:child_process";

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
}

export interface CommandRunner {
	run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

/** Give a command ten minutes; handoffs clone repositories. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** Command output stays small (herdr JSON, git status lines). */
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

/** The limits of the real runner; tests run real commands against small ones. */
export interface ChildProcessRunnerOptions {
	/** Kill a command that runs past this. Default: ten minutes. */
	timeoutMs?: number;
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
	const maxBuffer = options.maxBuffer ?? COMMAND_MAX_BUFFER;
	return {
		async run(command, args, options) {
			try {
				const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
					(resolve, reject) => {
						execFile(
							command,
							[...args],
							{
								encoding: "utf8",
								timeout: timeoutMs,
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
				return commandFailure(command, error, timeoutMs, maxBuffer);
			}
		},
	};
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
