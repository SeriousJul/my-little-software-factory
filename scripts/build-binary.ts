#!/usr/bin/env bun
/**
 * Build one prebuilt binary of the control plane.
 *
 * `bun run scripts/build-binary.ts <target> --out <dir>` compiles the entry
 * (src/factory.ts) through `bun build --compile` for one target: the output
 * is the standalone executable the release publishes and the npm package's
 * installer downloads (ADR 0056). The build stamps the package's version
 * into the binary, where the `--version` flag reads it, and it requires the
 * OpenTUI native core of the target in node_modules: the compile embeds the
 * core the install placed, so a missing core is a missing screen, not a
 * missing warning.
 *
 * The asset names come from src/binary-install.mjs, the module the published
 * installer reads: the producer and the consumer cannot name the same file
 * differently.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { assetFileName, TARGETS } from "../src/binary-install.mjs";

/** The repository root, from the scripts directory. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** One target the release publishes. */
export interface BinaryTarget {
	/** The target's id, as the release names the asset: `linux-x64`, ... */
	id: string;
	/** The `bun build --compile --target` value for the id. */
	bunTarget: string;
	/** The OpenTUI native core the target runs; the build must be installed. */
	opentuiPackage: string;
	/** The `bun add --os` value for the target's operating system. */
	os: string;
	/** The `bun add --cpu` value for the target's architecture. */
	cpu: string;
}

/** Every buildable target, keyed by id. */
export const BINARY_TARGETS: Readonly<Record<string, BinaryTarget>> = {
	"linux-x64": {
		id: "linux-x64",
		bunTarget: "bun-linux-x64",
		opentuiPackage: "@opentui/core-linux-x64",
		os: "linux",
		cpu: "x64",
	},
	"linux-x64-musl": {
		id: "linux-x64-musl",
		bunTarget: "bun-linux-x64-musl",
		opentuiPackage: "@opentui/core-linux-x64-musl",
		os: "linux",
		cpu: "x64",
	},
	"linux-arm64": {
		id: "linux-arm64",
		bunTarget: "bun-linux-aarch64",
		opentuiPackage: "@opentui/core-linux-arm64",
		os: "linux",
		cpu: "arm64",
	},
	"linux-arm64-musl": {
		id: "linux-arm64-musl",
		bunTarget: "bun-linux-aarch64-musl",
		opentuiPackage: "@opentui/core-linux-arm64-musl",
		os: "linux",
		cpu: "arm64",
	},
	"darwin-x64": {
		id: "darwin-x64",
		bunTarget: "bun-darwin-x64",
		opentuiPackage: "@opentui/core-darwin-x64",
		os: "darwin",
		cpu: "x64",
	},
	"darwin-arm64": {
		id: "darwin-arm64",
		bunTarget: "bun-darwin-aarch64",
		opentuiPackage: "@opentui/core-darwin-arm64",
		os: "darwin",
		cpu: "arm64",
	},
	"windows-x64": {
		id: "windows-x64",
		bunTarget: "bun-windows-x64",
		opentuiPackage: "@opentui/core-win32-x64",
		os: "win32",
		cpu: "x64",
	},
};

/** The `bun build` argument list that compiles one target to the asset's path. */
export function buildCommand(target: BinaryTarget, version: string, outPath: string): string[] {
	return [
		"build",
		"--compile",
		"src/factory.ts",
		`--target=${target.bunTarget}`,
		"--define",
		`FACTORY_BUILD_VERSION="${version}"`,
		`--outfile=${outPath}`,
	];
}

/** The package's version, the value the build stamps into the binary. */
export function packageVersion(): string {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
	if (typeof pkg.version !== "string" || pkg.version === "") {
		throw new Error("package.json carries no version to stamp into the binary");
	}
	return pkg.version;
}

/**
 * The OpenTUI native core of the target, present in node_modules.
 *
 * A plain install places only the core of the host, so a target that is not
 * the host takes an explicit add of its core at the installed version of
 * @opentui/core. The add is `--no-save`: the build's needs are the build's
 * to keep, not the repository's manifest.
 */
export async function ensureNativeCore(target: BinaryTarget): Promise<void> {
	if (existsSync(join(ROOT, "node_modules", target.opentuiPackage))) return;
	const corePkg = JSON.parse(
		readFileSync(join(ROOT, "node_modules", "@opentui/core", "package.json"), "utf8"),
	) as { version?: string };
	if (typeof corePkg.version !== "string" || corePkg.version === "") {
		throw new Error("the installed @opentui/core carries no version to match its core");
	}
	// The --os and --cpu overrides make the add place the target's core even
	// though the host is a different machine, and they keep the host's own
	// core out of the tree, so the compile embeds exactly one native core.
	const proc = Bun.spawn(
		[
			"bun",
			"add",
			"-D",
			"--no-save",
			`--os=${target.os}`,
			`--cpu=${target.cpu}`,
			`${target.opentuiPackage}@${corePkg.version}`,
		],
		{ cwd: ROOT, stdout: "inherit", stderr: "inherit" },
	);
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`the install of ${target.opentuiPackage} failed (exit ${code})`);
	}
}

/** Build one target into the given directory and report the asset's file name. */
export async function buildTarget(targetId: string, outDir: string): Promise<string> {
	const target = BINARY_TARGETS[targetId];
	if (target === undefined) {
		throw new Error(
			`unknown binary target: ${targetId}; the buildable targets are ${TARGETS.join(", ")}`,
		);
	}
	await ensureNativeCore(target);
	const version = packageVersion();
	const name = assetFileName(version, targetId);
	const outPath = join(outDir, name);
	const proc = Bun.spawn(["bun", ...buildCommand(target, version, outPath)], {
		cwd: ROOT,
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`bun build failed for ${targetId} (exit ${code})`);
	}
	return name;
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const targetId = argv[0];
	const outFlag = argv.indexOf("--out");
	if (
		targetId === undefined ||
		targetId.startsWith("--") ||
		outFlag < 0 ||
		argv[outFlag + 1] === undefined
	) {
		console.error("usage: bun run scripts/build-binary.ts <target> --out <dir>");
		console.error(`targets: ${TARGETS.join(", ")}`);
		process.exit(1);
	}
	try {
		const name = await buildTarget(targetId, argv[outFlag + 1]);
		console.log(`built ${name}`);
	} catch (error) {
		console.error(`build failed: ${String(error)}`);
		process.exit(1);
	}
}
