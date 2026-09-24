/**
 * The Default configuration the package ships.
 *
 * The file is imported as a file, not read at a resolved path. In a compiled
 * binary the module's own directory is a virtual path that holds code only:
 * a path built from `import.meta.url` misses the file, while the file
 * import's value reaches the copy the build embedded in the binary. In a
 * source run the value is the plain repository path, so one read serves
 * both modes and the seed stays verbatim (ADR 0020, ADR 0056).
 */
import { readFile } from "node:fs/promises";

import shippedDefaultToml from "../config/default.toml" with { type: "file" };

/**
 * The path of the Default configuration: the repository path in a source
 * run, the binary's embedded path in a compiled binary.
 */
export function shippedDefaultConfigPath(): string {
	return shippedDefaultToml;
}

/** The Default configuration's text, in a source run or a compiled binary. */
export async function readShippedDefaultConfigText(): Promise<string> {
	return await readFile(shippedDefaultConfigPath(), "utf8");
}
