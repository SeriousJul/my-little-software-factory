/**
 * Tests for the release build script's decisions.
 *
 * The script compiles one prebuilt binary of the control plane per target
 * (ADR 0056). What a test can read here is the decision layer: the targets
 * the build knows, the `bun build` argument list it runs, and the agreement
 * between the targets the build publishes and the targets the published
 * installer can resolve. The compile itself runs on the release workflow's
 * runners, and the smoke steps there run the binaries it builds.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BINARY_TARGETS,
	buildCommand,
	installedNativeCores,
	missingNativeCores,
	nativeCoreSetProblem,
	packageVersion,
	requiredNativeCores,
} from "../scripts/build-binary.ts";
import { assetFileName, TARGETS } from "../src/binary-install.mjs";

describe("the targets the build knows", () => {
	test("every target the installer resolves is buildable, and vice versa", () => {
		expect(Object.keys(BINARY_TARGETS).sort()).toEqual([...TARGETS].sort());
	});

	test.each(Object.values(BINARY_TARGETS))(
		"%s names a bun target, the OpenTUI core it runs, and the add's os and cpu",
		(target) => {
			expect(target.bunTarget).toBe(`bun-${target.id}`.replace("arm64", "aarch64"));
			expect(target.opentuiPackage).toMatch(/^@opentui\/core-[a-z0-9-]+$/);
			expect(target.os).toBe(
				target.id.split("-")[0] === "windows" ? "win32" : target.id.split("-")[0],
			);
			expect(["x64", "arm64"]).toContain(target.cpu);
		},
	);
});

describe("the build command", () => {
	test("the command compiles the entry for the target with the version stamped", () => {
		const target = BINARY_TARGETS["linux-x64"];
		expect(buildCommand(target, "0.2.0", "dist/factory-0.2.0-linux-x64")).toEqual([
			"build",
			"--compile",
			"src/factory.ts",
			"--target=bun-linux-x64",
			"--define",
			'FACTORY_BUILD_VERSION="0.2.0"',
			"--outfile=dist/factory-0.2.0-linux-x64",
		]);
	});

	test("the command writes to the asset path the build joins for the target", () => {
		for (const target of Object.values(BINARY_TARGETS)) {
			const outPath = `dist/${assetFileName("0.2.0", target.id)}`;
			const command = buildCommand(target, "0.2.0", outPath);
			expect(command).toContain(`--outfile=${outPath}`);
		}
	});
});

describe("the native cores a build may embed", () => {
	test("a linux target takes both libc siblings of its own arch, the rest take one", () => {
		// The loader's libc test reads process.env.OPENTUI_LIBC, which no
		// --target settles, so a linux compile must resolve both siblings. The
		// platform and arch branches are pruned, so a non-linux compile needs
		// exactly its own core - measured in docs/verification/release.md.
		expect(requiredNativeCores(BINARY_TARGETS["linux-x64"])).toEqual([
			"@opentui/core-linux-x64",
			"@opentui/core-linux-x64-musl",
		]);
		expect(requiredNativeCores(BINARY_TARGETS["linux-arm64-musl"])).toEqual([
			"@opentui/core-linux-arm64-musl",
			"@opentui/core-linux-arm64",
		]);
		expect(requiredNativeCores(BINARY_TARGETS["darwin-arm64"])).toEqual([
			"@opentui/core-darwin-arm64",
		]);
		expect(requiredNativeCores(BINARY_TARGETS["windows-x64"])).toEqual(["@opentui/core-win32-x64"]);
	});

	test("the set a target takes is the set its release leg installs", () => {
		// docs/verification/release.md records what each clean leg installed.
		// The check must pass those trees, or a leg would block its own upload.
		const legTrees: Record<string, string[]> = {
			"linux-x64": ["@opentui/core-linux-x64", "@opentui/core-linux-x64-musl"],
			"linux-x64-musl": ["@opentui/core-linux-x64", "@opentui/core-linux-x64-musl"],
			"linux-arm64": ["@opentui/core-linux-arm64", "@opentui/core-linux-arm64-musl"],
			"linux-arm64-musl": ["@opentui/core-linux-arm64", "@opentui/core-linux-arm64-musl"],
			"darwin-x64": ["@opentui/core-darwin-x64"],
			"darwin-arm64": ["@opentui/core-darwin-arm64"],
			"windows-x64": ["@opentui/core-win32-x64"],
		};
		for (const [targetId, installed] of Object.entries(legTrees)) {
			expect(nativeCoreSetProblem(BINARY_TARGETS[targetId], installed.sort())).toBeUndefined();
		}
	});

	test("a tree holding another target's core stops before the compile", () => {
		// A contributor's node_modules carries the host's core and every add a
		// earlier build left behind. The compile embeds what it can resolve, so
		// that tree builds a different artifact from the release's while naming
		// it the same: the measurement in the record would stop being true of
		// the file in front of you.
		const dirty = [
			"@opentui/core-darwin-arm64",
			"@opentui/core-linux-x64",
			"@opentui/core-linux-x64-musl",
		];
		const problem = nativeCoreSetProblem(BINARY_TARGETS["linux-x64"], dirty);
		expect(problem).toContain("@opentui/core-darwin-arm64");
		expect(problem).toContain("bun install --omit=optional");
		// The same tree is exactly right for the leg that targets that core.
		expect(nativeCoreSetProblem(BINARY_TARGETS["linux-x64"], dirty.slice(1))).toBeUndefined();
	});

	test("a non-linux target rejects the sibling a linux leg needs", () => {
		expect(
			nativeCoreSetProblem(BINARY_TARGETS["darwin-arm64"], [
				"@opentui/core-darwin-arm64",
				"@opentui/core-linux-x64-musl",
			]),
		).toContain("@opentui/core-linux-x64-musl");
	});

	test("the cores are read from the installed @opentui packages", () => {
		const dir = join(import.meta.dir, "..", "node_modules", "@opentui");
		const found = installedNativeCores(dir);
		// The real tree's contents vary by what was built last; the reader only
		// names core packages, never the bare @opentui/core that holds the loader.
		expect(found.every((name) => /^@opentui\/core-[a-z0-9-]+$/.test(name))).toBe(true);
		expect(found).not.toContain("@opentui/core");
		// A directory that is not there reads as no cores, not as a throw.
		expect(installedNativeCores(join(dir, "no-such-directory"))).toEqual([]);
	});

	test("the add names every core the target needs, not one and whatever else resolves", () => {
		// The loader's libc branch survives every --target, so a linux compile
		// needs both siblings of its architecture and a tree holding only the
		// glibc core fails the compile with `Could not resolve:
		// "@opentui/core-linux-x64-musl"`. Which siblings a resolver brings is its
		// optional-dependency filter's decision - measured on this host, a plain
		// `bun install` brought both x64 variants and
		// `bun install --omit=optional` brought none - so the build names what it
		// needs instead of depending on that.
		expect(missingNativeCores(BINARY_TARGETS["linux-x64"], ["@opentui/core-linux-x64"])).toEqual([
			"@opentui/core-linux-x64-musl",
		]);
		expect(missingNativeCores(BINARY_TARGETS["linux-x64"], [])).toEqual([
			"@opentui/core-linux-x64",
			"@opentui/core-linux-x64-musl",
		]);
		expect(
			missingNativeCores(BINARY_TARGETS["linux-arm64-musl"], [
				"@opentui/core-linux-arm64",
				"@opentui/core-linux-arm64-musl",
			]),
		).toEqual([]);
		expect(missingNativeCores(BINARY_TARGETS["darwin-arm64"], [])).toEqual([
			"@opentui/core-darwin-arm64",
		]);
		// The target's own core is the first thing it needs: the add never asks
		// for a sibling without the core it sits beside.
		for (const target of Object.values(BINARY_TARGETS)) {
			expect(requiredNativeCores(target)[0]).toBe(target.opentuiPackage);
		}
	});
});

describe("the version the build stamps", () => {
	test("the version comes from the repository's package.json", () => {
		expect(packageVersion()).toBe("0.1.0");
	});
});

describe("the command the build is called by", () => {
	test("the repository declares it, and it names this script", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};
		// `bun run build <target> --out <dir>` is what docs/development/commands.md
		// teaches and what the release leg runs.
		expect(pkg.scripts.build).toBe("bun run scripts/build-binary.ts");
	});

	test("a call without a target shows the command it wants back", async () => {
		const proc = Bun.spawn(
			[process.execPath, "run", join(import.meta.dir, "..", "scripts", "build-binary.ts")],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		await proc.exited;
		expect(stdout).toBe("");
		expect(stderr).toContain("usage: bun run build <target> --out <dir>");
		expect(stderr).toContain(TARGETS.join(", "));
	});
});
