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
import { BINARY_TARGETS, buildCommand, packageVersion } from "../scripts/build-binary.ts";
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
