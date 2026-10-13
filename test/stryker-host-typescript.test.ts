/**
 * The Stryker host's typescript shim (issue #377, ADR 0055).
 *
 * The campaign's host process resolves the bare specifier `typescript` per
 * package. The Stryker core's ts-config preprocessor reads exactly one
 * function from it, `parseConfigFileTextToJson`, and the typescript 7.0.2 the
 * repository declares at its top level - the native compiler line `bun run
 * typecheck` runs - exposes no such function, so the campaign died at its
 * first step before this shim stood. The entry point stages the shim under
 * core's own `node_modules`; these tests hold the staged package to the
 * contract the preprocessor leans on.
 *
 * The parse tests stand on plain JSON plus the two JSONC extensions the real
 * `parseConfigFileTextToJson` tolerates: comments and trailing commas. The
 * resolution tests run the campaign's host runtime over a tree that mirrors
 * the checkout: a top-level typescript that exposes no preprocessor API,
 * standing for the declared 7.0.2, and the staged shim under core's own
 * `node_modules`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIM_DIR = join(REPO_ROOT, "scripts", "stryker-host-typescript");
const requireFromShim = createRequire(join(SHIM_DIR, "index.cjs"));

const shim = requireFromShim("./index.cjs");

let tree: string;
let corePkg: string;

beforeAll(() => {
	tree = mkdtempSync(join(tmpdir(), "stryker-host-typescript-"));
	corePkg = join(tree, "node_modules", "@stryker-mutator", "core");
});

afterAll(() => {
	rmSync(tree, { recursive: true, force: true });
});

/**
 * The tree the resolution tests run over: the top-level typescript stands for
 * the declared 7.0.2 (a version export and no preprocessor API), and the
 * staged shim stands under core's own `node_modules`, where `mutate.sh` puts
 * it.
 */
function standHostTree() {
	const topLevel = join(tree, "node_modules", "typescript");
	mkdirSync(topLevel, { recursive: true });
	writeFileSync(
		join(topLevel, "package.json"),
		`${JSON.stringify({ name: "typescript", version: "7.0.2", main: "index.cjs" })}\n`,
		"utf8",
	);
	writeFileSync(
		join(topLevel, "index.cjs"),
		"module.exports = { version: '7.0.2', versionMajorMinor: '7.0' };\n",
		"utf8",
	);
	mkdirSync(join(corePkg, "node_modules"), { recursive: true });
	rmSync(join(corePkg, "node_modules", "typescript"), { recursive: true, force: true });
	mkdirSync(join(corePkg, "node_modules", "typescript"), { recursive: true });
	copyFileSync(
		join(SHIM_DIR, "package.json"),
		join(corePkg, "node_modules", "typescript", "package.json"),
	);
	copyFileSync(
		join(SHIM_DIR, "index.cjs"),
		join(corePkg, "node_modules", "typescript", "index.cjs"),
	);
}

/**
 * Run one probe file under the campaign's host runtime. The probe mirrors the
 * preprocessor's own import: a default import of the bare specifier.
 */
function runProbe(file: string): string {
	const run = spawnSync(process.execPath, [file], { encoding: "utf8" });
	if (run.status !== 0) {
		throw new Error(`probe died with ${run.status}: ${run.stderr}`);
	}
	return run.stdout;
}

const PROBE_SOURCE = `const { default: ts } = await import("typescript");
console.log(\`version=\${ts.version} parse=\${typeof ts.parseConfigFileTextToJson}\`);
`;

describe("the staged package stands as the typescript the host resolves", () => {
	it("is a package named typescript whose entry is the shim", () => {
		// The staging copies this manifest as `typescript` into core's own
		// `node_modules`; the bare specifier resolves it only on those two facts.
		const manifest = JSON.parse(readFileSync(join(SHIM_DIR, "package.json"), "utf8"));
		expect(manifest.name).toBe("typescript");
		expect(manifest.main).toBe("index.cjs");
		expect(existsSync(join(SHIM_DIR, "index.cjs"))).toBe(true);
	});

	it("exposes the preprocessor's function and nothing it would mistake for the real line", () => {
		// The preprocessor reads `parseConfigFileTextToJson` off the default
		// export. The surface stays that small: a Stryker release that reads more
		// must widen the shim on purpose, not find a native API it was never
		// checked for.
		expect(typeof shim.parseConfigFileTextToJson).toBe("function");
		expect(typeof shim.version).toBe("string");
		expect(Object.keys(shim).sort()).toEqual([
			"parseConfigFileTextToJson",
			"version",
			"versionMajorMinor",
		]);
	});

	it("answers the preprocessor's import from inside the Stryker core package", () => {
		standHostTree();
		const probeDir = join(corePkg, "dist", "src", "sandbox");
		mkdirSync(probeDir, { recursive: true });
		const probe = join(probeDir, "probe.mjs");
		writeFileSync(probe, PROBE_SOURCE, "utf8");
		// The host's import must reach the staged shim, not the top-level line
		// that exposes no preprocessor API: this is the resolution the crash of
		// issue #377 took the wrong way.
		expect(runProbe(probe)).toBe("version=1.0.0 parse=function\n");
	});

	it("leaves the top-level line to the packages that keep it", () => {
		standHostTree();
		const probe = join(tree, "outside-probe.mjs");
		writeFileSync(probe, PROBE_SOURCE, "utf8");
		// A file that stands outside the core package - the way the instrumenter
		// and the runner plugin stand - resolves the top-level typescript exactly
		// as before the shim, so the staging reaches no host code but the
		// preprocessor.
		expect(runProbe(probe)).toBe("version=7.0.2 parse=undefined\n");
	});
});

describe("parseConfigFileTextToJson answers the shape the preprocessor reads", () => {
	it("parses the repository's own tsconfig, the file a campaign's preprocessor reads", () => {
		// The sandbox copy holds this same file, and the preprocessor rewrites
		// its `extends`, `references`, and path arrays off this parse.
		const text = readFileSync(join(REPO_ROOT, "tsconfig.json"), "utf8");
		const { config, error } = shim.parseConfigFileTextToJson(
			join(REPO_ROOT, "tsconfig.json"),
			text,
		);
		expect(error).toBeUndefined();
		expect(config.include).toEqual(["src", "test"]);
		expect(config.compilerOptions).toBeDefined();
	});

	it("parses plain JSON the way JSON.parse does", () => {
		const { config, error } = shim.parseConfigFileTextToJson(
			"tsconfig.json",
			`{
			"compilerOptions": { "target": "esnext", "strict": true },
			"include": ["src"],
			"exclude": ["node_modules", "dist"]
		}`,
		);
		expect(error).toBeUndefined();
		expect(config).toEqual({
			compilerOptions: { target: "esnext", strict: true },
			include: ["src"],
			exclude: ["node_modules", "dist"],
		});
	});

	it("tolerates the comments and trailing commas the real parse tolerates", () => {
		const { config, error } = shim.parseConfigFileTextToJson(
			"tsconfig.json",
			`
			// a line comment
			{
				/* a block
				   comment */
				"extends": "../../base/tsconfig.json", // at the end
				"references": [ { "path": "../model" }, ],
				"include": ["src", "test",],
			}`,
		);
		expect(error).toBeUndefined();
		expect(config.extends).toBe("../../base/tsconfig.json");
		expect(config.references).toEqual([{ path: "../model" }]);
		expect(config.include).toEqual(["src", "test"]);
	});

	it("answers the escape forms a config file can carry", () => {
		// The text carries the escape sequences, not the characters they name: the
		// shim's parse is what turns them around.
		const text = '{"include": ["src/\\u0061bc", "src\\there", "src/quote\\"here"]}';
		const { config, error } = shim.parseConfigFileTextToJson("tsconfig.json", text);
		expect(error).toBeUndefined();
		expect(config.include).toEqual(["src/abc", "src\there", 'src/quote"here']);
	});

	it("answers an object with a number, a literal, and a null", () => {
		const { config } = shim.parseConfigFileTextToJson(
			"tsconfig.json",
			`{
			"concurrency": 25,
			"ratio": 1.5,
			"negative": -3,
			"on": true,
			"off": false,
			"gap": null
		}`,
		);
		expect(config).toEqual({
			concurrency: 25,
			ratio: 1.5,
			negative: -3,
			on: true,
			off: false,
			gap: null,
		});
	});

	for (const [name, text] of [
		["a value without a key", `{"include"}`],
		["a key without a value", `{"include": }`],
		["trailing text after the object", `{} extra`],
		["an unterminated string", `{"include": ["src`],
		["an unterminated block comment", `{"include": ["src"] /* never closed`],
		["an invalid escape", `{"include": ["src\\q"]}`],
		["a \\u escape with no hex digits", `{"include": ["src/\\u00"]}`],
		["a trailing backslash in a string", `{"include": ["src\\"]}`],
		["a bare word", `{"include": src}`],
	] as const) {
		it(`refuses ${name}, with the fault named`, () => {
			const { config, error } = shim.parseConfigFileTextToJson("tsconfig.json", text);
			// The preprocessor takes `config` and acts only when it is an object:
			// a broken file rewrites nothing, the same answer it gives a file it
			// cannot read. The error stands for a record, named by its message.
			expect(config).toBeUndefined();
			expect(error).toBeDefined();
			expect(typeof error?.messageText).toBe("string");
			expect(error?.messageText.length).toBeGreaterThan(0);
			expect(error?.file).toBe("tsconfig.json");
		});
	}

	it("answers a top-level array with no config and no fault", () => {
		// JSON allows an array at the top level and the real parse reports no
		// fault for one; there is only no object for the preprocessor to
		// rewrite.
		const { config, error } = shim.parseConfigFileTextToJson("tsconfig.json", `["src", "test"]`);
		expect(config).toBeUndefined();
		expect(error).toBeUndefined();
	});
});
