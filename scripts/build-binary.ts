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
 * loader names eight platform packages in literal dynamic imports
 * (`core-darwin-x64`, `core-darwin-arm64`, `core-linux-x64`,
 * `core-linux-x64-musl`, `core-linux-arm64`, `core-linux-arm64-musl`,
 * `core-win32-x64`, `core-win32-arm64`), each behind a branch on
 * `process.platform` and `process.arch` that the bundler prunes for the
 * `--target` it is given. So the branches a target never reaches are not
 * resolved, and a non-linux leg needs one core: `--target=bun-darwin-arm64`
 * compiles a tree that holds only `core-darwin-arm64`.
 *
 * What the bundler cannot prune is the libc test inside the linux branches:
 * `if (process.env.OPENTUI_LIBC === "musl")`. An environment read is not
 * statically knowable at build time - setting `OPENTUI_LIBC=glibc` for the
 * compile does not settle it - so on a linux leg both the glibc and the musl
 * sibling of the target's architecture must resolve. The add names them one by
 * one rather than leaving the pair to `bun add`'s os/cpu filter, which resolves
 * no libc, and the compiled linux binaries carry both - about 6.3 MB of native
 * library a given machine never loads. So the add is not a size measure: on a
 * linux leg it is the step that makes the imports the compile cannot prune
 * resolvable at all. The four linux, two darwin, and windows legs are measured
 * target by target in docs/verification/release.md, and the build refuses a
 * tree that holds a core outside the target's set: the compile embeds every
 * core it can resolve, so that tree builds a different artifact under the
 * release's own name.
 * Dropping the dead variant is not a local flag: `--external` moves the
 * specifier to run time in a binary that has no run-time `node_modules`, and
 * deleting the sibling from a linux tree fails the build with an unresolved
 * import, so the fix is upstream: OpenTUI's loader has to make the libc choice
 * statically knowable, or the sibling stays.
 *
 * The asset names come from src/binary-install.mjs, the module the published
 * installer reads: the producer and the consumer cannot name the same file
 * differently, and the release workflow's own steps are pinned against them
 * by test/release-workflow.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
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
	/** The OpenTUI native core this target runs at the last branch it can reach. */
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

/**
 * The OpenTUI native cores a linux target's compile must resolve.
 *
 * The loader's libc test reads `process.env.OPENTUI_LIBC`, which no
 * `--target` settles, so a linux leg needs both the glibc and the musl
 * sibling of its own architecture, and no other architecture's and no
 * non-linux package. A non-linux target reaches one core.
 */
export function requiredNativeCores(target: BinaryTarget): string[] {
	const base = `@opentui/core-${target.os}-${target.cpu}`;
	if (target.os !== "linux") return [base];
	return target.id.endsWith("-musl") ? [`${base}-musl`, base] : [base, `${base}-musl`];
}

/**
 * The native cores a build tree holds, and the line a wrong set gets.
 *
 * The release legs start from `bun install --omit=optional`, so their tree is
 * the set their own add places. A contributor's tree is not: it carries the
 * host's core and every add a previous build left behind, and a tree holding
 * seven cores builds a `darwin-arm64` binary that embeds one and a `linux-x64`
 * binary that embeds two - the artifact is then a different thing from the
 * release's, while every log line says it is the same build. This check makes
 * the claim a fact for both: the set has to be exactly the target's, and a
 * tree that holds more names the extras and the command that clears them.
 */
export function nativeCoreSetProblem(
	target: BinaryTarget,
	installed: string[],
): string | undefined {
	const required = requiredNativeCores(target);
	const extra = installed.filter((name) => !required.includes(name));
	if (extra.length === 0) return undefined;
	return (
		`node_modules holds ${installed.length} OpenTUI native cores; the ` +
		`${target.id} build takes exactly ${required.join(" and ")}. Extra: ` +
		`${extra.join(", ")}. The compile embeds every core it can resolve, so ` +
		"this tree would build an artifact the release does not publish. " +
		"Run 'bun install --omit=optional' for the release's tree, or remove " +
		"the extra packages from node_modules."
	);
}

/** The OpenTUI native core packages present in a node_modules directory. */
export function installedNativeCores(nodeModulesDir: string): string[] {
	try {
		return readdirSync(nodeModulesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith("core-"))
			.map((entry) => `@opentui/${entry.name}`)
			.sort();
	} catch {
		// No node_modules at all: nothing to complain about, and the compile
		// itself stops with its own error.
		return [];
	}
}

/**
 * The cores the target needs that a tree does not hold.
 *
 * The add names these one by one: `bun add` resolves an os/cpu pair and no
 * libc, so leaving the sibling to the pair would depend on the resolver's
 * optional-dependency filter rather than on this build's own decision.
 */
export function missingNativeCores(target: BinaryTarget, installed: string[]): string[] {
	return requiredNativeCores(target).filter((name) => !installed.includes(name));
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
 * The OpenTUI native cores of the target, present in node_modules.
 *
 * This is the step that makes `@opentui/core`'s platform imports resolvable
 * for the bundler, not a step that trims the artifact: see this file's header.
 * The add runs for every core the target needs and the tree lacks, so a Linux
 * build on a host that took only its glibc core from a plain install still
 * finds the musl sibling the compile cannot prune away. A tree that is already
 * complete - a contributor's, or a re-run leg - builds with no add at all.
 * The add is `--no-save`: the build's needs are the build's to keep, not the
 * repository's manifest.
 */
export async function ensureNativeCore(target: BinaryTarget): Promise<void> {
	const missing = missingNativeCores(
		target,
		installedNativeCores(join(ROOT, "node_modules", "@opentui")),
	);
	if (missing.length === 0) return;
	const corePkg = JSON.parse(
		readFileSync(join(ROOT, "node_modules", "@opentui/core", "package.json"), "utf8"),
	) as { version?: string };
	if (typeof corePkg.version !== "string" || corePkg.version === "") {
		throw new Error("the installed @opentui/core carries no version to match its core");
	}
	// The --os and --cpu overrides make the add place the target's cores even
	// though the host is a different machine. They resolve an os/cpu pair, not a
	// libc, so the cores are named one by one rather than left to the pair.
	const proc = Bun.spawn(
		[
			"bun",
			"add",
			"-D",
			"--no-save",
			`--os=${target.os}`,
			`--cpu=${target.cpu}`,
			...missing.map((name) => `${name}@${corePkg.version}`),
		],
		{ cwd: ROOT, stdout: "inherit", stderr: "inherit" },
	);
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`the install of ${missing.join(", ")} failed (exit ${code})`);
	}
}

/**
 * Fail before the compile when the tree holds cores the target must not embed.
 */
export function checkNativeCoreSet(target: BinaryTarget): void {
	const problem = nativeCoreSetProblem(
		target,
		installedNativeCores(join(ROOT, "node_modules", "@opentui")),
	);
	if (problem !== undefined) throw new Error(problem);
}

/** Build one target into the given directory and report the asset's file name. */
export async function buildTarget(targetId: string, outDir: string): Promise<string> {
	const target = BINARY_TARGETS[targetId];
	if (target === undefined) {
		throw new Error(
			`unknown binary target: ${targetId}; the buildable targets are ${TARGETS.join(", ")}`,
		);
	}
	// The check runs before the add: a tree this build will reject should not be
	// changed by it on the way to the rejection.
	checkNativeCoreSet(target);
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
