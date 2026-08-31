/**
 * Filesystem helpers shared by the modules that do plain file work
 * (the config load and write, the repository resolution).
 *
 * The control plane does this work through `node:fs/promises`: async, and
 * the event loop never blocks on a file.
 */
import { access } from "node:fs/promises";

/** Whether a path exists and is accessible. */
export async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
