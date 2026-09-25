/**
 * Filesystem helpers shared by the modules that do plain file work
 * (the config load and write, the repository resolution).
 *
 * The control plane does this work through `node:fs/promises`: async, and
 * the event loop never blocks on a file.
 */
import { access, readdir, rename } from "node:fs/promises";

/** Whether a path exists and is accessible. */
export async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The entry names inside one directory, or null when the path is no readable
 * directory. A read of a path that is absent reads as null too: the caller
 * keeps its own answer for "nothing stands there", so this stays one question.
 */
export async function readDirectoryNames(path: string): Promise<string[] | null> {
	try {
		return await readdir(path);
	} catch {
		return null;
	}
}

/**
 * Move one path to another, and answer whether the move ran.
 *
 * The rename fails when the target is taken between the caller's check and
 * this call, and when either path is off-limits: both answer false, so the
 * caller reports the state it did not change rather than a half move.
 */
export async function movePath(from: string, to: string): Promise<boolean> {
	try {
		await rename(from, to);
		return true;
	} catch {
		return false;
	}
}
