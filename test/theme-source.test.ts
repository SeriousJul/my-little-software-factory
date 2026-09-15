/**
 * The theme seam: the one place the resolution touches the machine.
 *
 * The pure rules are tested in the resolver's own file; this file tests the
 * path herdr's config is read from, the in-herdr fact, and the once-per-
 * process rule: a running plane holds its resolution and a theme change
 * takes effect at the next startup.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { BUILTIN_THEMES, STANDALONE_THEME } from "../src/components/shared/theme.ts";
import {
	currentThemeResolution,
	herdrConfigPath,
	resetThemeResolution,
} from "../src/theme-source.ts";

afterEach(() => {
	resetThemeResolution();
});

describe("herdrConfigPath", () => {
	test("the operator's explicit path stands", () => {
		expect(herdrConfigPath({ HERDR_CONFIG_PATH: "/x/config.toml" }, "/home/u")).toBe(
			"/x/config.toml",
		);
	});

	test("then the XDG config home", () => {
		expect(herdrConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/xdg/herdr/config.toml");
	});

	test("then the standard home location", () => {
		expect(herdrConfigPath({}, "/home/u")).toBe("/home/u/.config/herdr/config.toml");
	});
});

describe("currentThemeResolution", () => {
	test("outside herdr it is the standalone theme", () => {
		expect(currentThemeResolution({}, "/home/u").theme).toBe(STANDALONE_THEME);
	});

	test("inside herdr it inherits the config's theme", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-seam-"));
		const path = join(dir, "config.toml");
		writeFileSync(path, '[theme]\nname = "nord"\n');
		try {
			const out = currentThemeResolution({ HERDR_ENV: "1", HERDR_CONFIG_PATH: path }, "/home/u");
			expect(out.theme.name).toBe("nord");
			expect(out.theme.roles).toEqual(BUILTIN_THEMES.nord.roles);
			expect(out.warning).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("any non-empty HERDR_ENV is the in-herdr fact, and an empty one is not", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-seam-"));
		const path = join(dir, "config.toml");
		writeFileSync(path, '[theme]\nname = "nord"\n');
		try {
			// The mark is that the variable is set, not its value: herdr does
			// not promise one, so any other value still means herdr started
			// this pane and the config is the plane's to read.
			expect(
				currentThemeResolution({ HERDR_ENV: "pane", HERDR_CONFIG_PATH: path }, "/home/u").theme
					.name,
			).toBe("nord");
			// An empty value is unset, so the standalone theme stands.
			expect(
				currentThemeResolution({ HERDR_ENV: "", HERDR_CONFIG_PATH: path }, "/home/u").theme,
			).toBe(STANDALONE_THEME);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the resolution is one startup fact: a running plane does not re-read the config", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-seam-"));
		const path = join(dir, "config.toml");
		writeFileSync(path, '[theme]\nname = "nord"\n');
		try {
			const env = { HERDR_ENV: "1", HERDR_CONFIG_PATH: path };
			expect(currentThemeResolution(env, "/home/u").theme.name).toBe("nord");
			// The operator changes herdr's theme in the running plane's life:
			// the change is the next startup's fact, not this process's.
			writeFileSync(path, '[theme]\nname = "dracula"\n');
			expect(currentThemeResolution(env, "/home/u").theme.name).toBe("nord");
			// The next startup re-reads the environment and takes the change.
			resetThemeResolution();
			expect(currentThemeResolution(env, "/home/u").theme.name).toBe("dracula");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a different environment is a different resolution", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-seam-"));
		const path = join(dir, "config.toml");
		writeFileSync(path, '[theme]\nname = "nord"\n');
		try {
			// The same file, read from outside herdr, is the standalone theme.
			expect(currentThemeResolution({ HERDR_CONFIG_PATH: path }, "/home/u").theme).toBe(
				STANDALONE_THEME,
			);
			expect(
				currentThemeResolution({ HERDR_ENV: "1", HERDR_CONFIG_PATH: path }, "/home/u").theme.name,
			).toBe("nord");
			// And the standalone reading holds when asked again outside herdr.
			expect(currentThemeResolution({ HERDR_CONFIG_PATH: path }, "/home/u").theme).toBe(
				STANDALONE_THEME,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unreadable config file reads as absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-seam-"));
		const nested = join(dir, "deeper");
		// A path that cannot hold a file: the read fails and the built-in
		// default stands, the way a missing config does.
		mkdirSync(nested);
		try {
			const out = currentThemeResolution(
				{ HERDR_ENV: "1", HERDR_CONFIG_PATH: join(nested, "a-file") },
				"/home/u",
			);
			expect(out.theme.name).toBe("catppuccin");
			expect(out.warning).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
