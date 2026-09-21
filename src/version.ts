/**
 * The version of the running control plane.
 *
 * A compiled binary carries its version as the build-time constant the
 * release build stamps through `bun build --define`: the binary embeds no
 * file the version could be read from. A source run reads the repository's
 * package.json, the same file the release workflow checks against the tag
 * (ADR 0020, ADR 0056).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

/**
 * The version: the stamped value in a compiled binary, the package.json
 * value in a source run, and `unknown` where no source of it can be read.
 */
export async function factoryVersion(): Promise<string> {
	if (typeof FACTORY_BUILD_VERSION !== "undefined") return FACTORY_BUILD_VERSION;
	try {
		const text = await readFile(PACKAGE_JSON, "utf8");
		const pkg = JSON.parse(text) as { version?: string };
		if (typeof pkg.version === "string" && pkg.version !== "") return pkg.version;
	} catch {
		// No readable package.json: the flag reports unknown, it does not fail.
	}
	return "unknown";
}
