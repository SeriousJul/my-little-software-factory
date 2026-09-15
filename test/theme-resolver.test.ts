/**
 * The pure theme resolver, driven from strings alone.
 *
 * The resolver takes herdr's config text (or its absence) and the in-herdr
 * fact, and returns the theme the control plane paints plus the warning that
 * explains any fallback. No file, no environment, and no command: a test
 * states a config and reads the outcome. The built-in definitions, the name
 * aliases, the sibling pairs, and the color grammar are vendored from herdr
 * 0.9.0 (ADR 0024).
 */
import { describe, expect, test } from "vitest";

import {
	BUILTIN_THEMES,
	canonicalThemeName,
	DEFAULT_THEME_NAME,
	HERDR_THEME_VERSION,
	parseThemeColor,
	resolveTheme,
	STANDALONE_THEME,
	siblingThemeNames,
	THEME_ROLES,
} from "../src/components/shared/theme.ts";

describe("outside herdr", () => {
	test("the standalone theme stands, with or without a herdr config", () => {
		// No config to read and nothing to say.
		const absent = resolveTheme(null, false);
		expect(absent.theme).toBe(STANDALONE_THEME);
		expect(absent.warning).toBeNull();
		// A herdr config that exists is not the control plane's to read:
		// outside herdr the plane paints its own theme.
		const present = resolveTheme('[theme]\nname = "dracula"\n', false);
		expect(present.theme).toBe(STANDALONE_THEME);
		expect(present.warning).toBeNull();
	});
});

describe("inside herdr", () => {
	test("a missing config resolves the built-in default without a warning", () => {
		// herdr itself starts on its built-in default when its config is
		// missing; the plane follows herdr, and there is no problem to report.
		const out = resolveTheme(null, true);
		expect(out.theme).toBe(BUILTIN_THEMES[DEFAULT_THEME_NAME]);
		expect(out.theme.name).toBe("catppuccin");
		expect(out.warning).toBeNull();
	});

	test("a named theme stands with its own palette", () => {
		const out = resolveTheme('[theme]\nname = "tokyo-night"\n', true);
		expect(out.theme.name).toBe("tokyo-night");
		expect(out.theme.appearance).toBe("dark");
		expect(out.theme.roles.text).toBe("#c0caf5");
		expect(out.theme.roles.accent).toBe("#7aa2f7");
		expect(out.warning).toBeNull();
	});

	test("a name herdr aliases or normalizes resolves to the built-in", () => {
		// The normalization and the aliases are herdr's own: lowercase, spaces
		// and underscores to hyphens, then the alias map.
		const names = {
			"Tokyo Night": "tokyo-night",
			"catppuccin-mocha": "catppuccin",
			latte: "catppuccin-latte",
			"gruvbox-dark": "gruvbox",
			rose_pine: "rose-pine",
			"Rose Pine Dawn": "rose-pine-dawn",
		} as const;
		for (const [stated, canonical] of Object.entries(names)) {
			expect(resolveTheme(`[theme]\nname = "${stated}"\n`, true).theme.name).toBe(canonical);
		}
	});

	test("an unknown theme falls back to the default and says so", () => {
		const out = resolveTheme('[theme]\nname = "frobnicate"\n', true);
		expect(out.theme.name).toBe(DEFAULT_THEME_NAME);
		expect(out.warning).toBe(
			`unknown theme name "frobnicate" in herdr's config; using the built-in default catppuccin`,
		);
	});

	test("a config with no [theme] section falls back and says so", () => {
		const out = resolveTheme("[agents]\ncodex = {}\n", true);
		expect(out.theme.name).toBe(DEFAULT_THEME_NAME);
		expect(out.warning).toBe(
			"herdr's config has no [theme] section; using the built-in default catppuccin",
		);
	});

	test("an unparseable config falls back and says so", () => {
		const out = resolveTheme("this is not = toml", true);
		expect(out.theme.name).toBe(DEFAULT_THEME_NAME);
		expect(out.warning).toBe(
			"herdr's config file is not valid TOML; using the built-in default catppuccin",
		);
	});

	test("a [theme] that is not a table falls back and says so", () => {
		const out = resolveTheme("theme = 5\n", true);
		expect(out.theme.name).toBe(DEFAULT_THEME_NAME);
		expect(out.warning).toBe(
			"herdr's config [theme] is not a table; using the built-in default catppuccin",
		);
	});

	test("a [theme] that names no theme uses the built-in default", () => {
		const out = resolveTheme("[theme]\n", true);
		expect(out.theme.name).toBe(DEFAULT_THEME_NAME);
		expect(out.warning).toBeNull();
	});

	test("auto_switch stands the dark sibling of the stated name", () => {
		// The control plane never guesses the host appearance: with
		// auto_switch on and no dark_name, the dark sibling stands.
		expect(
			resolveTheme('[theme]\nname = "tokyo-night-day"\nauto_switch = true\n', true).theme.name,
		).toBe("tokyo-night");
		expect(
			resolveTheme('[theme]\nname = "catppuccin-latte"\nauto_switch = true\n', true).theme.name,
		).toBe("catppuccin");
		// Without auto_switch the stated name stands, light and all.
		expect(resolveTheme('[theme]\nname = "catppuccin-latte"\n', true).theme.name).toBe(
			"catppuccin-latte",
		);
	});

	test("auto_switch with a dark_name stands the dark_name", () => {
		const out = resolveTheme(
			'[theme]\nname = "dracula"\nauto_switch = true\ndark_name = "nord"\n',
			true,
		);
		expect(out.theme.name).toBe("nord");
		expect(out.theme.roles.text).toBe(BUILTIN_THEMES.nord.roles.text);
		expect(out.warning).toBeNull();
	});

	test("an unknown dark_name falls back and says so", () => {
		const out = resolveTheme('[theme]\nauto_switch = true\ndark_name = "nope"\n', true);
		expect(out.theme.name).toBe(DEFAULT_THEME_NAME);
		expect(out.warning).toBe(
			`unknown theme name "nope" in herdr's config; using the built-in default catppuccin`,
		);
	});

	test("theme.custom overrides apply per token", () => {
		const out = resolveTheme(
			'[theme]\nname = "nord"\n[theme.custom]\ntext = "#112233"\naccent = "reset"\n',
			true,
		);
		expect(out.theme.name).toBe("nord");
		expect(out.theme.roles.text).toBe("#112233");
		expect(out.theme.roles.accent).toBe("reset");
		// A token the override does not name keeps the base theme's value.
		expect(out.theme.roles.green).toBe(BUILTIN_THEMES.nord.roles.green);
		expect(out.warning).toBeNull();
	});

	test("a value the grammar does not take drops only that token", () => {
		const out = resolveTheme(
			'[theme]\nname = "nord"\n[theme.custom]\ntext = "not a color"\nred = "rgb(1, 2, 256)"\n',
			true,
		);
		expect(out.theme.roles.text).toBe(BUILTIN_THEMES.nord.roles.text);
		expect(out.theme.roles.red).toBe(BUILTIN_THEMES.nord.roles.red);
		expect(out.warning).toBeNull();
	});

	test("an override in one theme does not reach another", () => {
		const nord = resolveTheme('[theme]\nname = "nord"\n[theme.custom]\ntext = "#112233"\n', true);
		const dracula = resolveTheme('[theme]\nname = "dracula"\n', true);
		expect(nord.theme.roles.text).toBe("#112233");
		expect(dracula.theme.roles.text).toBe(BUILTIN_THEMES.dracula.roles.text);
	});
});

describe("the color grammar", () => {
	test("hex, rgb, the named ANSI colors, and reset", () => {
		expect(parseThemeColor("#abcDEF")).toBe("#abcdef");
		expect(parseThemeColor("#abc")).toBe("#aabbcc");
		expect(parseThemeColor("rgb(1, 2, 3)")).toBe("#010203");
		// The slots are herdr's renderer's: gray stands the white slot, darkgray
		// the bright black slot, and white the bright white slot. These pins catch
		// drift in the named-color table.
		expect(parseThemeColor("gray")).toBe("#c0c0c0");
		expect(parseThemeColor("darkgray")).toBe("#808080");
		expect(parseThemeColor("darkgrey")).toBe("#808080");
		expect(parseThemeColor("white")).toBe("#ffffff");
		expect(parseThemeColor("lightblue")).toBe("#0000ff");
		expect(parseThemeColor("lightwhite")).toBe("#ffffff");
		expect(parseThemeColor("reset")).toBe("reset");
		expect(parseThemeColor("default")).toBe("reset");
	});

	test("a value outside the grammar is refused", () => {
		expect(parseThemeColor("not a color")).toBeNull();
		expect(parseThemeColor("#gggggg")).toBeNull();
		expect(parseThemeColor("rgb(1, 2, 256)")).toBeNull();
		expect(parseThemeColor("#12345")).toBeNull();
	});
});

describe("the name rules", () => {
	test("canonicalThemeName normalizes and aliases", () => {
		expect(canonicalThemeName("Catppuccin Mocha")).toBe("catppuccin");
		expect(canonicalThemeName("tokyo night")).toBe("tokyo-night");
		expect(canonicalThemeName("frobnicate")).toBeNull();
	});

	test("siblingThemeNames pairs the dark and light of a family", () => {
		expect(siblingThemeNames("catppuccin")).toEqual({
			dark: "catppuccin",
			light: "catppuccin-latte",
		});
		expect(siblingThemeNames("tokyo-night-day")).toEqual({
			dark: "tokyo-night",
			light: "tokyo-night-day",
		});
		// A name outside the map names itself in both appearances.
		expect(siblingThemeNames("vesper")).toEqual({ dark: "vesper", light: "vesper" });
	});
});

describe("the vendored definitions", () => {
	test("every built-in resolves every role to a value the renderer paints", () => {
		for (const [name, theme] of Object.entries(BUILTIN_THEMES)) {
			for (const role of THEME_ROLES) {
				const value = theme.roles[role];
				expect(
					value === "reset" || /^#[0-9a-f]{6}$/.test(value),
					`${name}.${role} = ${value}`,
				).toBe(true);
			}
		}
	});

	test("the 18 built-ins stand, vendored from herdr 0.9.0", () => {
		expect(HERDR_THEME_VERSION).toBe("0.9.0");
		expect(Object.keys(BUILTIN_THEMES).sort()).toEqual(
			[
				"catppuccin",
				"catppuccin-latte",
				"terminal",
				"tokyo-night",
				"tokyo-night-day",
				"dracula",
				"nord",
				"gruvbox",
				"gruvbox-light",
				"one-dark",
				"one-light",
				"solarized",
				"solarized-light",
				"kanagawa",
				"kanagawa-lotus",
				"rose-pine",
				"rose-pine-dawn",
				"vesper",
			].sort(),
		);
	});

	test("the terminal theme resolves reset and the named ANSI colors", () => {
		const terminal = BUILTIN_THEMES.terminal;
		// herdr's `Reset` stands as `reset`, and a named color stands as the
		// RGB of its SGR slot: the table stores the values already parsed.
		expect(terminal.roles.text).toBe("reset");
		expect(terminal.roles.panel_bg).toBe("reset");
		expect(terminal.roles.accent).toBe("#000080");
		// The named-color tokens stand where herdr's own renderer stands them:
		// herdr's terminal theme paints its border and active row at DarkGray
		// (the bright black slot) and its subtext at Gray (the white slot).
		expect(terminal.roles.surface_dim).toBe("#808080");
		expect(terminal.roles.active_row_bg).toBe("#808080");
		expect(terminal.roles.subtext0).toBe("#c0c0c0");
		expect(terminal.roles.mauve).toBe("#c0c0c0");
	});
});
