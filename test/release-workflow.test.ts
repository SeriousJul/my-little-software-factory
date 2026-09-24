/**
 * Tests for the release workflow's part in the prebuilt binary.
 *
 * Three parties name a release asset: the build script that writes it, the
 * installer that downloads it, and `.github/workflows/release.yml`, which
 * runs the file on its own operating system and uploads it. The first two
 * share `assetFileName`, so they cannot disagree (test/installer.test.ts
 * pins that). This file pins the third: the workflow is plain text to a unit
 * test, and a step that names a file the build never produces, or that loses
 * the mode it needs to run what it downloaded, blocks the only upload the
 * installer has.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assetFileName, checksumFileName, DATA_DIR, TARGETS } from "../src/binary-install.mjs";

const WORKFLOWS_DIR = join(import.meta.dir, "..", ".github", "workflows");
const RELEASE_YML = readFileSync(join(WORKFLOWS_DIR, "release.yml"), "utf8");

/** The version the manifests declare, the one a tag must match. */
const VERSION = JSON.parse(
	readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
).version;

/**
 * The asset name as a build step names it when the version is a shell
 * variable or a wildcard: the real name with its version segment replaced.
 */
function assetGlobFor(targetId: string): string {
	return assetFileName(VERSION, targetId).replace(VERSION, "*");
}

const DOLLAR = String.fromCharCode(36);

/**
 * A shell expansion as the workflow writes it, assembled so this file holds
 * no live template placeholder.
 */
function shellVar(name: string): string {
	return `${DOLLAR}{${name}}`;
}

/** A shell `*` glob, with its quotes dropped, as a whole-name regular expression. */
function shellGlobToRegExp(pattern: string): RegExp {
	const source = pattern
		.replace(/"/g, "")
		.replace(/[.+^${}()|[\]\\?]/g, "\\$&")
		.replace(/\*/g, ".*");
	return new RegExp(`^${source}$`);
}

/** The names in `files` a shell glob selects, in the order it would pass them. */
function shellExpand(pattern: string, files: string[]): string[] {
	const matches = shellGlobToRegExp(pattern);
	return files.filter((file) => matches.test(file));
}

describe("the targets the release builds", () => {
	test("the build matrix lists every target the installer can resolve", () => {
		const matrix = RELEASE_YML.slice(
			RELEASE_YML.indexOf("        target:"),
			RELEASE_YML.indexOf("    steps:", RELEASE_YML.indexOf("        target:")),
		);
		const listed = [...matrix.matchAll(/^ {10}- (\S+)$/gm)].map((match) => match[1]);
		expect(listed.sort()).toEqual([...TARGETS].sort());
	});

	test("the release job checks for every target's asset before it uploads", () => {
		const loop = RELEASE_YML.match(/for t in ([^;]+); do/);
		expect(loop).not.toBeNull();
		expect(loop?.[1].trim().split(/\s+/).sort()).toEqual([...TARGETS].sort());
	});
});

describe("the asset names the workflow's steps use", () => {
	test("every asset name a step reads is one target's shared asset name", () => {
		// The shape a step uses when it cannot know the version: the shared
		// name with its version segment left as a wildcard.
		const named = [...RELEASE_YML.matchAll(/dist\/(factory-[*][^\s"')]*)/g)].map((m) => m[1]);
		expect(named.length).toBeGreaterThan(0);
		// The build leg names its asset `dist/factory-*` and asserts the count
		// is one: it knows its own target and no other. Every other name in the
		// file spans targets, so each must be exactly one target's shared name.
		for (const name of named.filter((one) => one !== "factory-*")) {
			expect(TARGETS.filter((targetId) => name === assetGlobFor(targetId))).toHaveLength(1);
		}
		expect(named).toContain(assetGlobFor("darwin-arm64"));
		expect(named).toContain(assetGlobFor("windows-x64"));
	});

	test("each smoke step names exactly its own target", () => {
		for (const targetId of ["darwin-arm64", "windows-x64"]) {
			const glob = assetGlobFor(targetId);
			expect(RELEASE_YML).toContain(glob);
			// No other target's asset matches the same pattern.
			expect(TARGETS.filter((t) => assetGlobFor(t) === glob)).toEqual([targetId]);
		}
	});

	test("the checksums file the release job writes is the one the installer reads", () => {
		expect(RELEASE_YML).toContain(checksumFileName(VERSION).replace(VERSION, shellVar("version")));
	});

	test("the upload step sends every asset and the checksums file, and nothing else", () => {
		// The one line that decides what the release carries. Last round's
		// blocking finding was a `dist/factory-<version>-*` glob that matched the
		// seven binaries and not the sums file, whose separator is a `.`: the npm
		// package published, the binaries uploaded, and no install could complete
		// on any platform, because the installer's first fetch is the sums file.
		// So: take the names the module produces, add what else can sit in a
		// re-run's dist, and apply the workflow's own glob to that directory.
		const upload = RELEASE_YML.match(/gh release upload \S+ (.+?) --clobber/);
		expect(upload).not.toBeNull();
		// One shell pattern, and it names the version as a shell variable: a
		// literal version in an upload line is a second name to drift from the
		// shared one.
		expect(upload?.[1]).toContain(shellVar("version"));
		const pattern = (upload?.[1] ?? "").replace(shellVar("version"), VERSION).replace(/"/g, "");
		const stray = ["dist/SHA256SUMS.txt", "dist/factory-nightly.zip", "dist/artifact-hashes"];
		const dist = [
			...TARGETS.map((targetId) => `dist/${assetFileName(VERSION, targetId)}`),
			`dist/${checksumFileName(VERSION)}`,
			...stray,
		];
		expect(shellExpand(pattern, dist)).toEqual(dist.filter((name) => !stray.includes(name)));
	});

	test("the release job checks the checksums file before it uploads it", () => {
		// The completeness loop checked the seven binaries with `test -s` and
		// never the sums file, which is how the missing upload stayed invisible.
		const job = RELEASE_YML.slice(RELEASE_YML.indexOf("  release:"));
		expect(job).toMatch(/if ! test -s "dist\/\$sums"/);
		// Every asset the release carries is named by the file, so an install of
		// any target finds its line.
		expect(job).toContain(`grep -q "  ${DOLLAR}{file##dist/}$" "dist/${DOLLAR}sums"`);
		expect(job).toContain("sha256sum -c --strict");
	});

	test("the release job's own file name is the shared asset name", () => {
		// The job builds `dist/factory-<version>-<target><ext>`, with `.exe` for
		// the windows targets: evaluate that text for every target and compare.
		const template = RELEASE_YML.match(/file="dist\/(factory-[^"]+)"/);
		expect(template).not.toBeNull();
		for (const targetId of TARGETS) {
			const extension = targetId.startsWith("windows") ? ".exe" : "";
			const built = template?.[1]
				.replace(shellVar("version"), VERSION)
				.replace(shellVar("t"), targetId)
				.replace(shellVar("ext"), extension);
			expect(built).toBe(assetFileName(VERSION, targetId));
		}
	});
});

describe("the steps that run a binary on its own operating system", () => {
	/**
	 * One step's own text, with its shell line continuations joined.
	 *
	 * A step is the block between its `- name:` line and the next step at the
	 * same indentation. The continuations are joined because a captured command
	 * spans them: the alpine leg's `docker run` is one command over two lines.
	 */
	function stepBlock(name: string): string {
		const lines = RELEASE_YML.split("\n");
		const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
		expect(start, `no step named: ${name}`).toBeGreaterThanOrEqual(0);
		const indent = lines[start].search(/\S/);
		const body: string[] = [lines[start]];
		for (const line of lines.slice(start + 1)) {
			if (line.trim() === "") continue;
			if (line.search(/\S/) <= indent) break;
			body.push(line);
		}
		return body.join(" ").replace(/\\\s+/g, " ");
	}

	/** Every step that runs a built binary and asks it for its version. */
	function versionSmokeSteps(): string[] {
		return [...RELEASE_YML.matchAll(/^ {6}- name: (The .* answers --version.*)$/gm)].map(
			(match) => match[1],
		);
	}

	test("each leg runs a version smoke at all", () => {
		expect(versionSmokeSteps()).toHaveLength(4);
	});

	test("every version smoke compares the binary's answer with the tag's version", () => {
		// Exit 0 is not the property. A compiled binary prints `factory unknown`
		// with exit 0 the moment the build's version stamp stops reaching
		// src/version.ts, and every smoke would stay green while the release
		// shipped binaries that lie about what they are. The version line is
		// also the only thing in the smoke that ties the artifact to the tag.
		for (const name of versionSmokeSteps()) {
			const step = stepBlock(name);
			// The answer is read into a variable, not written to the log: the
			// POSIX legs capture a command substitution and the PowerShell leg
			// assigns a pipeline, and either way the text has to be in hand before
			// the step decides.
			expect(step).toMatch(/answer="\$\(|\$answer = \(/);
			// The expected line comes from the tag, the one value the release's
			// own version is measured against.
			expect(step).toMatch(/\$\{GITHUB_REF_NAME#v\}|GITHUB_REF_NAME\.Substring\(1\)/);
			expect(step).toMatch(/factory /);
			// And a mismatch ends the step nonzero.
			expect(step).toMatch(
				/test "\$answer" = "\$want" \|\| \{[^}]*exit 1|if \(\$answer -ne \$want\)[\s\S]*exit 1/,
			);
		}
	});

	test("no version smoke ends by running the binary for its output alone", () => {
		// The shape the fix replaced: the step's last act was `"$asset"
		// --version`, so the run proved only that the file starts.
		for (const name of versionSmokeSteps()) {
			const step = stepBlock(name);
			expect(step).not.toMatch(/(?:^|\s)"\$asset" --version\s*;?\s*$/);
			expect(step).not.toMatch(/& \$assets\[0\]\.FullName --version\s*$/);
		}
	});

	test("the build leg runs its own target and exactly one file", () => {
		// The leg runs the repository's own build command: the command a
		// contributor types is the command that ships.
		expect(RELEASE_YML).toMatch(/bun run build \$\{\{ matrix\.target \}\} --out dist/);
		expect(RELEASE_YML).toContain('test "$(ls dist/factory-* | wc -l)" -eq 1');
	});

	test("the musl binary is smoked in an alpine container with the runtime it links", () => {
		expect(RELEASE_YML).toContain("docker run");
		expect(RELEASE_YML).toMatch(/alpine:\d+\.\d+/);
		// Measured on the musl binary of this branch: without the GNU C++
		// runtime the alpine container dies on a relocation error before the
		// binary answers, and the leg that proves the musl target blocks every
		// upload.
		expect(RELEASE_YML).toContain("apk add --no-cache libstdc++");
	});

	test("the macOS leg makes its downloaded binary executable before it runs it", () => {
		// upload-artifact stores no file modes, so a downloaded Mach-O comes
		// back 644 and the leg would die on permission before it proves
		// anything about the binary.
		const leg = RELEASE_YML.slice(
			RELEASE_YML.indexOf("  smoke-darwin:"),
			RELEASE_YML.indexOf("  smoke-windows:"),
		);
		expect(leg).toContain("actions/download-artifact@v7");
		expect(leg).toContain("chmod +x");
		expect(leg.indexOf("chmod +x")).toBeLessThan(leg.indexOf('"$asset" --version'));
	});

	test("the release job waits on every smoke before it uploads", () => {
		const needs = RELEASE_YML.match(/ {2}release:[\s\S]*?needs: \[([^\]]+)\]/);
		expect(needs?.[1].replace(/\s/g, "")).toBe("build,smoke-darwin,smoke-windows");
	});

	test("a re-run completes an existing release instead of failing on its name", () => {
		expect(RELEASE_YML).toContain(`gh release view "v${shellVar("version")}"`);
		expect(RELEASE_YML).toContain("gh release create");
		expect(RELEASE_YML).toContain("gh release upload");
	});
});

describe("the compiler the release ships from", () => {
	test("every workflow pins the same Bun, the one the record measured", () => {
		const pins = new Map<string, string[]>();
		for (const name of ["release.yml", "ci.yml", "site-deploy.yml"]) {
			const text = readFileSync(join(WORKFLOWS_DIR, name), "utf8");
			pins.set(
				name,
				[...text.matchAll(/bun-version: (\S+)/g)].map((match) => match[1]),
			);
		}
		const values = [...new Set([...pins.values()].flat())];
		expect(values).toHaveLength(1);
		// The record in docs/verification/release.md names this version as the
		// compiler the cross-compile and the binary runs were measured on.
		expect(values[0]).toBe("1.4.2");
	});

	test("the build legs install without the optional platform cores", () => {
		expect(RELEASE_YML).toContain("bun install --omit=optional");
	});
});

describe("the workflow file's own shape", () => {
	test("no step's run block leaks its text back to column zero", () => {
		// A `run: |` block ends where a line loses the block's indentation, so a
		// wrapped note or a here-doc body written at column zero silently cuts
		// the script short: the first tag's release job lost its
		// `gh release upload` line that way, and GitHub parsed the note's prose
		// as top-level keys. Every line that is not indented under a key must be
		// a top-level key of the file itself.
		for (const name of ["release.yml", "ci.yml", "site-deploy.yml"]) {
			const text = readFileSync(join(WORKFLOWS_DIR, name), "utf8");
			const leaked = text
				.split("\n")
				.map((line, index) => ({ line, number: index + 1 }))
				.filter(
					({ line }) =>
						line.trim() !== "" &&
						!line.startsWith(" ") &&
						!line.startsWith("#") &&
						!/^[a-zA-Z][\w-]*:($| )/.test(line),
				);
			expect(leaked, `${name} leaks these lines to column zero`).toEqual([]);
		}
	});

	test("the release job's create step still holds its upload line", () => {
		// The one step that must survive the check above: the create and the
		// upload are one script, and a cut in it drops the upload with no error.
		const job = RELEASE_YML.slice(RELEASE_YML.indexOf("  release:"));
		const step = job.slice(job.indexOf("Upload the binaries"));
		expect(step).toContain("gh release create");
		expect(step.indexOf("gh release create")).toBeLessThan(step.indexOf("gh release upload"));
	});
});

describe("what the installer and the package declare", () => {
	test("the published package carries the installer alone", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
			files: string[];
			dependencies?: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		expect([...pkg.files].sort()).toEqual(["bin/factory-bin.mjs", "src/binary-install.mjs"]);
		// The app's runtime libraries belong to the binary the build embeds,
		// not to the installer an operator runs: a clean install of the
		// package must not pull them.
		expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
		for (const name of ["@opentui/core", "@opentui/react", "react", "smol-toml", "string-width"]) {
			expect(pkg.devDependencies).toHaveProperty(name);
			expect(pkg.dependencies ?? {}).not.toHaveProperty(name);
		}
	});

	test("the cache the installer writes is the one the docs name", () => {
		// The data-home name appears in the first-run guide; a path that moves
		// without the docs is a path the operator cannot clean up.
		expect(DATA_DIR).toBe("my-little-software-factory");
		const guide = readFileSync(
			join(import.meta.dir, "..", "docs", "getting-started", "first-launch.md"),
			"utf8",
		);
		expect(guide).toContain(`~/.local/share/${DATA_DIR}/bin/<target>`);
	});
});
