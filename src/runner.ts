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
export interface CommandRunner {
	run(command: string, args: readonly string[]): Promise<CommandResult>;
}

/** Give a command ten minutes; handoffs clone repositories. */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
/** Command output stays small (herdr JSON, git status lines). */
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * The real runner: one child process per command through execFile.
 *
 * A program that cannot start (not installed, not in PATH) or a command
 * that runs past the timeout is a failed command with a readable stderr,
 * not a thrown error: the caller reports the reason in the TUI.
 */
export function createChildProcessRunner(): CommandRunner {
	return {
		async run(command, args) {
			try {
				const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
					(resolve, reject) => {
						execFile(
							command,
							[...args],
							{
								encoding: "utf8",
								timeout: COMMAND_TIMEOUT_MS,
								maxBuffer: COMMAND_MAX_BUFFER,
							},
							(error, stdout, stderr) => {
								if (error && typeof error.code !== "number") {
									// A spawn-level failure (ENOENT, timeout),
									// not a non-zero exit.
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
				return commandFailure(command, error);
			}
		},
	};
}

/** Map a spawn-level failure to a failed command with a readable reason. */
function commandFailure(command: string, error: unknown): CommandResult {
	const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
	if (err.code === "ENOENT") {
		return { code: 127, stdout: "", stderr: `${command} not found in PATH` };
	}
	if (err.killed || err.signal) {
		return {
			code: 124,
			stdout: "",
			stderr: `${command} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`,
		};
	}
	return { code: 1, stdout: "", stderr: String(err.message ?? error) };
}
