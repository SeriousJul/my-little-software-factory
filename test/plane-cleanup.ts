/**
 * The plane's one cleanup pass, held in the preload the test runner runs for
 * every test file of the run.
 *
 * The plane registers its close here when it opens, and the hook drains the
 * register at the end of every test, in every file of the run. A module-scope
 * `afterEach` inside the plane's own file would bind to the one file that
 * first imports it: Bun evaluates a run's modules once, and a plain test file
 * that imports the plane without preloading would leak the plane it opened.
 * The preload's hook belongs to no file, so it holds for all of them, with or
 * without `--isolate`: the runner evaluates the preload's modules in each
 * worker the isolated run starts, and in the one process the plain run uses.
 *
 * The theme-isolation hold stands on the same shape: one preloaded module owns
 * the hook, and the module it wraps only records.
 */
import { afterEach } from "bun:test";

interface PlaneClose {
	close(): void;
}
const openPlanes: PlaneClose[] = [];

/** Hold one plane's close until the test that opened it ends. */
export function holdPlaneClose(close: () => void): void {
	openPlanes.push({ close });
}

afterEach(() => {
	for (const reg of openPlanes.splice(0)) reg.close();
});
