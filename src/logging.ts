/**
 * The control plane's file logging.
 *
 * The plane is a TUI: it owns the terminal, so after boot nothing it learns
 * may go to stdout or stderr. This module writes the plane's own record to a
 * file the operator reads later: one line per event, level-filtered,
 * rotated by size. A log write never throws into the plane - the file is a
 * record, and a dead disk must not end a run.
 */
import {
	closeSync,
	mkdirSync,
	openSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** The levels the operator selects, from silent to everything. */
export type LogLevel = "off" | "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = {
	off: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
};

/** The label each level writes into its line. */
const LEVEL_LABEL: Record<LogLevel, string> = {
	off: "OFF",
	error: "ERROR",
	warn: "WARN",
	info: "INFO",
	debug: "DEBUG",
};

/** The record the plane keeps: one level-tagged line per event. */
export interface Logger {
	readonly level: LogLevel;
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/** The logger a seam without logging hands a consumer that expects one. */
export const NOOP_LOGGER: Logger = {
	level: "off",
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

export interface LoggerOptions {
	/** The level that passes the filter; "off" keeps no file and no line. */
	level: LogLevel;
	/** The log file; missing parent directories are created. */
	file: string;
	/** Rotate the current file at this size, in bytes. */
	maxSizeBytes: number;
	/** Rotated files kept: file.1 through file. <keep>. */
	keep: number;
}

/**
 * A level-filtering, size-rotating file logger. Every line is
 * `<ISO timestamp> <LEVEL> <message>`. The write is synchronous on purpose:
 * a run ends between event and write, and the record must survive the end.
 */
export function createLogger(options: LoggerOptions): Logger {
	const rank = LEVEL_RANK[options.level];
	if (rank === 0 || options.file === "") return NOOP_LOGGER;

	const write = (level: LogLevel, message: string): void => {
		if (LEVEL_RANK[level] > rank) return;
		try {
			rotateIfNeeded(options);
			const line = `${new Date().toISOString()} ${LEVEL_LABEL[level]} ${message}`;
			mkdirSync(dirname(options.file), { recursive: true });
			const handle = openSync(options.file, "a");
			try {
				writeSync(handle, `${line}\n`);
			} finally {
				closeSync(handle);
			}
		} catch {
			// A log failure never ends the run it records.
		}
	};

	return {
		level: options.level,
		debug: (message) => write("debug", message),
		info: (message) => write("info", message),
		warn: (message) => write("warn", message),
		error: (message) => write("error", message),
	};
}

/**
 * Move the current file to .1 and shift the rotated files up one, dropping
 * the one that falls out of the keep window, when the current file reaches
 * its size.
 */
function rotateIfNeeded(options: LoggerOptions): void {
	let current: { size: number };
	try {
		current = statSync(options.file);
	} catch {
		return;
	}
	if (current.size < options.maxSizeBytes) return;
	try {
		unlinkSync(`${options.file}.${options.keep}`);
	} catch {
		// No file at the window's edge: nothing to drop.
	}
	for (let index = options.keep - 1; index >= 1; index--) {
		try {
			renameSync(`${options.file}.${index}`, `${options.file}.${index + 1}`);
		} catch {
			// No file at this step: the window is shorter than its edge.
		}
	}
	renameSync(options.file, `${options.file}.1`);
}
