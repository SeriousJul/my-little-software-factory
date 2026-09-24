#!/usr/bin/env bun
/**
 * Build one prebuilt binary of the control plane.
 *
 * `bun run build <target> --out <dir>` compiles the entry (src/factory.ts)
 * through `bun build --compile` for one target: the output is the standalone
 * executable the release publishes and the npm package's installer downloads
 * (ADR 0056), and the release leg runs this same command. The build stamps the
 * package's version into the binary, where the `--version` flag reads it, and
 * it requires the OpenTUI native core of the target in node_modules.
 *
 * What that add is for, and what it does not do: `@opentui/core`'s asset
 * loader names all six platform packages - one per os, arch, and libc - in
 * literal dynamic imports, and the bundler must resolve every one of them
 * whatever `--target` it is given. So the add is not a size measure: it is the
 * step that makes those imports resolvable at all, and a tree that holds only
 * one core does not compile. `bun add` resolves an `os`/`cpu` pair rather than
 * a libc, so on a linux leg it places both the glibc and the musl variant, and
 * the compiled linux binaries carry both - about 6.3 MB of native library a
 * given machine never loads. The four linux, two darwin, and windows legs are
 * measured target by target in docs/verification/release.md. Dropping the dead
 * variant is not a local flag: `--external` moves the specifier to run time in
 * a binary that has no run-time `node_modules`, and deleting the sibling from
 * the tree fails the build with an unresolved import, so the fix is upstream
 * in OpenTUI's loader or nowhere.
 *
 * The asset names come from src/binary-install.mjs, the module the published
 * installer reads: the producer and the consumer cannot name the same file
 * differently, and the release workflow's own steps are pinned against them
 * by test/release-workflow.test.ts.
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
 * This is the step that makes `@opentui/core`'s six literal platform imports
 * resolvable for the bundler, not a step that trims the artifact: see this
 * file's header. A plain install places only the host's core, so a target that
 * is not the host takes an explicit add of its core at the installed version of
 * @opentui/core. The add is `--no-save`: the build's needs are the build's to
 * keep, not the repository's manifest.
 *
 * The guard is an early return on the target's own package, so a tree that
 * already carries it - a contributor's, or a re-run leg - builds without a
 * second add. It is not a claim about how many cores the tree holds: on a linux
 * leg that holds both variants, as the add itself places them, it compiles and
 * the output carries both.
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
	// though the host is a different machine. They resolve an os/cpu pair, not a
	// libc, so a linux add brings both linux variants - which is what the
	// compile needs, and what the linux artifacts ship.
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
		console.error("usage: bun run build <target> --out <dir>");
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
