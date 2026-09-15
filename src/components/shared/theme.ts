/**
 * Theme resolution: the pure core of the control plane's color system.
 *
 * A Theme is the resolved set of color roles the control plane paints every
 * surface with. Inside herdr, the control plane inherits the theme from
 * herdr's own config file: this module takes the config text (or its
 * absence) and the in-herdr fact, and returns the resolved theme plus the
 * warning that explains any fallback. Outside herdr, it returns the
 * standalone theme, the fixed dark palette the control plane defines for
 * itself (ADR 0024).
 *
 * This module is pure: no file, no environment, and no command access
 * inside it. The caller reads herdr's config file and hands in the text, so
 * a test drives the whole rule set from strings alone.
 *
 * The built-in definitions, the name aliases, the sibling pairs, and the
 * color grammar are vendored from herdr 0.9.0 - its `Palette` constructors,
 * its `canonical_theme_name` and `sibling_theme_names`, and its
 * `parse_color`. HERDR_THEME_VERSION records the copy source, so drift
 * between herdr and the control plane is a data update, not a hunt.
 */
import { parse } from "smol-toml";

/** The herdr version the built-in definitions were copied from. */
export const HERDR_THEME_VERSION = "0.9.0";

/** A theme's appearance, stated so a surface never guesses it. */
export type ThemeAppearance = "dark" | "light";

/**
 * The color roles the control plane paints.
 *
 * The names are herdr's token names. The control plane defines only the
 * roles it paints; a role it does not name is not a role it must keep.
 */
export type ThemeRole =
	| "text"
	| "subtext0"
	| "surface_dim"
	| "accent"
	| "active_row_bg"
	| "panel_bg"
	| "red"
	| "yellow"
	| "blue"
	| "green"
	| "mauve";

/** Every role a theme must resolve. */
export const THEME_ROLES: readonly ThemeRole[] = [
	"text",
	"subtext0",
	"surface_dim",
	"accent",
	"active_row_bg",
	"panel_bg",
	"red",
	"yellow",
	"blue",
	"green",
	"mauve",
];

/**
 * One resolved role value.
 *
 * A `#rrggbb` color the renderer paints as-is, or `reset`, which tells the
 * renderer to emit no color code for the role so the terminal's own default
 * shows through. The terminal theme paints this way, and so does a custom
 * override that names `reset`.
 */
export type ThemeRoleValue = string;

/** One resolved theme. */
export interface Theme {
	/** The built-in name the theme resolved to. */
	name: string;
	appearance: ThemeAppearance;
	roles: Record<ThemeRole, ThemeRoleValue>;
}

/** The outcome of one startup resolution. */
export interface ThemeResolution {
	theme: Theme;
	/** The reason a fallback took, for the Message line. `null` when the config resolved clean. */
	warning: string | null;
}

/**
 * The standard 16 ANSI colors, at the RGB values the standard SGR codes
 * define for their slots.
 *
 * A named color is a theme fact, not a terminal fact: herdr names the SGR
 * slot, and the plane's renderer emits truecolor, so the slot paints at its
 * standard RGB value no matter what palette the terminal itself holds.
 */
const ANSI16_RGB = [
	"#000000", // black
	"#800000", // red
	"#008000", // green
	"#808000", // yellow
	"#000080", // blue
	"#800080", // magenta
	"#008080", // cyan
	"#c0c0c0", // white
	"#808080", // gray (bright black)
	"#ff0000", // light_red (bright red)
	"#00ff00", // light_green (bright green)
	"#ffff00", // light_yellow (bright yellow)
	"#0000ff", // light_blue (bright blue)
	"#ff00ff", // light_magenta (bright magenta)
	"#00ffff", // light_cyan (bright cyan)
	"#ffffff", // light_white (bright white)
] as const;

/**
 * The named colors herdr's grammar accepts, each to the SGR slot herdr's
 * own renderer paints for it.
 *
 * The slots are herdr's, not the classic terminal names: its renderer sends
 * `gray` to the white slot (37), `darkgray` to the bright black slot (90),
 * and `white` to the bright white slot (97).
 */
const ANSI_NAMES: Record<string, number> = {
	black: 0,
	red: 1,
	green: 2,
	yellow: 3,
	blue: 4,
	magenta: 5,
	purple: 5,
	cyan: 6,
	white: 15,
	gray: 7,
	grey: 7,
	darkgray: 8,
	darkgrey: 8,
	lightred: 9,
	lightgreen: 10,
	lightyellow: 11,
	lightblue: 12,
	lightmagenta: 13,
	lightcyan: 14,
	lightwhite: 15,
};

/**
 * Parse one color value in herdr's grammar.
 *
 * Hex (`#rgb` or `#rrggbb`), `rgb(r,g,b)`, one of the 16 named ANSI colors,
 * and the reset aliases. Returns `null` for a value the grammar does not
 * take: the caller drops that one value, never the whole theme.
 */
export function parseThemeColor(value: string): ThemeRoleValue | null {
	const raw = value.trim().toLowerCase();
	if (raw === "reset" || raw === "default" || raw === "none" || raw === "transparent") {
		return "reset";
	}
	if (raw.startsWith("#")) {
		const hex = raw.slice(1);
		if (hex.length === 6 && /^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
		if (hex.length === 3 && /^[0-9a-f]{3}$/.test(hex)) {
			const [r, g, b] = [hex[0], hex[1], hex[2]].map((c) =>
				(Number.parseInt(c, 16) * 17).toString(16).padStart(2, "0"),
			);
			return `#${r}${g}${b}`;
		}
		return null;
	}
	if (raw.startsWith("rgb(") && raw.endsWith(")")) {
		const parts = raw
			.slice(4, -1)
			.split(",")
			.map((part) => part.trim());
		if (parts.length === 3) {
			const channels = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
			if (
				channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
			) {
				return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
			}
		}
		return null;
	}
	const slot = ANSI_NAMES[raw];
	return slot === undefined ? null : ANSI16_RGB[slot];
}

/**
 * The built-in name a config name resolves to, or `null` when herdr does not
 * know it.
 *
 * The normalization and the aliases are herdr's own: lowercase, spaces and
 * underscores to hyphens, then the alias map.
 */
export function canonicalThemeName(name: string): string | null {
	const normalized = name.toLowerCase().replace(/[\s_]/g, "-");
	const aliases: Record<string, string> = {
		catppuccin: "catppuccin",
		"catppuccin-mocha": "catppuccin",
		"catppuccin-latte": "catppuccin-latte",
		latte: "catppuccin-latte",
		light: "catppuccin-latte",
		terminal: "terminal",
		"tokyo-night": "tokyo-night",
		tokyonight: "tokyo-night",
		"tokyo-night-day": "tokyo-night-day",
		"tokyo-day": "tokyo-night-day",
		"tokyonight-day": "tokyo-night-day",
		dracula: "dracula",
		nord: "nord",
		gruvbox: "gruvbox",
		"gruvbox-dark": "gruvbox",
		"gruvbox-light": "gruvbox-light",
		"one-dark": "one-dark",
		onedark: "one-dark",
		"one-light": "one-light",
		onelight: "one-light",
		solarized: "solarized",
		"solarized-dark": "solarized",
		"solarized-light": "solarized-light",
		kanagawa: "kanagawa",
		"kanagawa-lotus": "kanagawa-lotus",
		lotus: "kanagawa-lotus",
		"rose-pine": "rose-pine",
		rosepine: "rose-pine",
		"rose-pine-dawn": "rose-pine-dawn",
		"rosepine-dawn": "rose-pine-dawn",
		dawn: "rose-pine-dawn",
		vesper: "vesper",
	};
	return aliases[normalized] ?? null;
}

/**
 * The dark and light siblings of one theme name.
 *
 * herdr's own sibling map, used when `auto_switch` is on and the config
 * states no explicit `dark_name`. A name outside the map names itself in
 * both appearances.
 */
export function siblingThemeNames(name: string): { dark: string; light: string } {
	const normalized = name.toLowerCase().replace(/[\s_]/g, "-");
	const pairs: Record<string, { dark: string; light: string }> = {
		catppuccin: { dark: "catppuccin", light: "catppuccin-latte" },
		"catppuccin-mocha": { dark: "catppuccin", light: "catppuccin-latte" },
		"catppuccin-latte": { dark: "catppuccin", light: "catppuccin-latte" },
		latte: { dark: "catppuccin", light: "catppuccin-latte" },
		light: { dark: "catppuccin", light: "catppuccin-latte" },
		"tokyo-night": { dark: "tokyo-night", light: "tokyo-night-day" },
		tokyonight: { dark: "tokyo-night", light: "tokyo-night-day" },
		"tokyo-night-day": { dark: "tokyo-night", light: "tokyo-night-day" },
		"tokyo-day": { dark: "tokyo-night", light: "tokyo-night-day" },
		"tokyonight-day": { dark: "tokyo-night", light: "tokyo-night-day" },
		gruvbox: { dark: "gruvbox", light: "gruvbox-light" },
		"gruvbox-dark": { dark: "gruvbox", light: "gruvbox-light" },
		"gruvbox-light": { dark: "gruvbox", light: "gruvbox-light" },
		"one-dark": { dark: "one-dark", light: "one-light" },
		onedark: { dark: "one-dark", light: "one-light" },
		"one-light": { dark: "one-dark", light: "one-light" },
		onelight: { dark: "one-dark", light: "one-light" },
		solarized: { dark: "solarized", light: "solarized-light" },
		"solarized-dark": { dark: "solarized", light: "solarized-light" },
		"solarized-light": { dark: "solarized", light: "solarized-light" },
		kanagawa: { dark: "kanagawa", light: "kanagawa-lotus" },
		"kanagawa-lotus": { dark: "kanagawa", light: "kanagawa-lotus" },
		lotus: { dark: "kanagawa", light: "kanagawa-lotus" },
		"rose-pine": { dark: "rose-pine", light: "rose-pine-dawn" },
		rosepine: { dark: "rose-pine", light: "rose-pine-dawn" },
		"rose-pine-dawn": { dark: "rose-pine", light: "rose-pine-dawn" },
		"rosepine-dawn": { dark: "rose-pine", light: "rose-pine-dawn" },
		dawn: { dark: "rose-pine", light: "rose-pine-dawn" },
	};
	const pair = pairs[normalized];
	return pair ?? { dark: name, light: name };
}

/** The theme herdr resolves when its config states no name. */
export const DEFAULT_THEME_NAME = "catppuccin";

/**
 * One built-in theme, as herdr 0.9.0 defines it, over the roles the
 * control plane paints.
 *
 * A value is the grammar this module parses: herdr's own RGB triples as
 * hex, its named ANSI colors by name, and its `Reset` as `reset`.
 */
interface BuiltinDefinition {
	appearance: ThemeAppearance;
	roles: Record<ThemeRole, string>;
}

const BUILTIN_DEFINITIONS: Record<string, BuiltinDefinition> = {
	catppuccin: {
		appearance: "dark",
		roles: {
			text: "#cdd6f4",
			subtext0: "#a6adc8",
			surface_dim: "#1e1e2e",
			accent: "#89b4fa",
			active_row_bg: "#1e1e2e",
			panel_bg: "#181825",
			red: "#f38ba8",
			yellow: "#f9e2af",
			blue: "#89b4fa",
			green: "#a6e3a1",
			mauve: "#cba6f7",
		},
	},
	"catppuccin-latte": {
		appearance: "light",
		roles: {
			text: "#4c4f69",
			subtext0: "#6c6f85",
			surface_dim: "#e6e9ef",
			accent: "#1e66f5",
			active_row_bg: "#e6e9ef",
			panel_bg: "#eff1f5",
			red: "#d20f39",
			yellow: "#df8e1d",
			blue: "#1e66f5",
			green: "#40a02b",
			mauve: "#8839ef",
		},
	},
	terminal: {
		appearance: "dark",
		roles: {
			text: "reset",
			subtext0: "gray",
			surface_dim: "darkgray",
			accent: "blue",
			active_row_bg: "darkgray",
			panel_bg: "reset",
			red: "lightred",
			yellow: "yellow",
			blue: "blue",
			green: "green",
			mauve: "gray",
		},
	},
	"tokyo-night": {
		appearance: "dark",
		roles: {
			text: "#c0caf5",
			subtext0: "#a9b1d6",
			surface_dim: "#1a1b26",
			accent: "#7aa2f7",
			active_row_bg: "#232636",
			panel_bg: "#1a1b26",
			red: "#f7768e",
			yellow: "#e0af68",
			blue: "#7aa2f7",
			green: "#9ece6a",
			mauve: "#bb9af7",
		},
	},
	"tokyo-night-day": {
		appearance: "light",
		roles: {
			text: "#3760bf",
			subtext0: "#6172b0",
			surface_dim: "#d2d3da",
			accent: "#2e7de9",
			active_row_bg: "#d2d3da",
			panel_bg: "#e1e2e7",
			red: "#f52a65",
			yellow: "#8c6c3e",
			blue: "#2e7de9",
			green: "#587539",
			mauve: "#7847bd",
		},
	},
	dracula: {
		appearance: "dark",
		roles: {
			text: "#f8f8f2",
			subtext0: "#d2d2dc",
			surface_dim: "#282a36",
			accent: "#bd93f9",
			active_row_bg: "#373c52",
			panel_bg: "#282a36",
			red: "#ff5555",
			yellow: "#f1fa8c",
			blue: "#8be9fd",
			green: "#50fa7b",
			mauve: "#ff79c6",
		},
	},
	nord: {
		appearance: "dark",
		roles: {
			text: "#eceff4",
			subtext0: "#d8dee9",
			surface_dim: "#2e3440",
			accent: "#88c0d0",
			active_row_bg: "#434c5e",
			panel_bg: "#2e3440",
			red: "#bf616a",
			yellow: "#ebcb8b",
			blue: "#81a1c1",
			green: "#a3be8c",
			mauve: "#b48ead",
		},
	},
	gruvbox: {
		appearance: "dark",
		roles: {
			text: "#ebdbb2",
			subtext0: "#d5c4a1",
			surface_dim: "#282828",
			accent: "#d79921",
			active_row_bg: "#323130",
			panel_bg: "#282828",
			red: "#fb4934",
			yellow: "#fabd2f",
			blue: "#83a598",
			green: "#b8bb26",
			mauve: "#d3869b",
		},
	},
	"gruvbox-light": {
		appearance: "light",
		roles: {
			text: "#3c3836",
			subtext0: "#504945",
			surface_dim: "#f2e5bc",
			accent: "#076678",
			active_row_bg: "#f2e5bc",
			panel_bg: "#fbf1c7",
			red: "#9d0006",
			yellow: "#b57614",
			blue: "#076678",
			green: "#79740e",
			mauve: "#8f3f71",
		},
	},
	"one-dark": {
		appearance: "dark",
		roles: {
			text: "#abb2bf",
			subtext0: "#969ca8",
			surface_dim: "#282c34",
			accent: "#61afef",
			active_row_bg: "#313640",
			panel_bg: "#282c34",
			red: "#e06c75",
			yellow: "#e5c07b",
			blue: "#61afef",
			green: "#98c379",
			mauve: "#c678dd",
		},
	},
	"one-light": {
		appearance: "light",
		roles: {
			text: "#383a42",
			subtext0: "#686b77",
			surface_dim: "#f5f5f6",
			accent: "#4078f2",
			active_row_bg: "#d8dbe2",
			panel_bg: "#fafafa",
			red: "#e45649",
			yellow: "#c18401",
			blue: "#4078f2",
			green: "#50a14f",
			mauve: "#a626a4",
		},
	},
	solarized: {
		appearance: "dark",
		roles: {
			text: "#93a1a1",
			subtext0: "#839496",
			surface_dim: "#002b36",
			accent: "#268bd2",
			active_row_bg: "#164b57",
			panel_bg: "#002b36",
			red: "#dc322f",
			yellow: "#b58900",
			blue: "#268bd2",
			green: "#859900",
			mauve: "#d33682",
		},
	},
	"solarized-light": {
		appearance: "light",
		roles: {
			text: "#657b83",
			subtext0: "#839496",
			surface_dim: "#eee8d5",
			accent: "#268bd2",
			active_row_bg: "#eee8d5",
			panel_bg: "#fdf6e3",
			red: "#dc322f",
			yellow: "#b58900",
			blue: "#268bd2",
			green: "#859900",
			mauve: "#d33682",
		},
	},
	kanagawa: {
		appearance: "dark",
		roles: {
			text: "#dcd7ba",
			subtext0: "#c8c3aa",
			surface_dim: "#1f1f28",
			accent: "#7e9cd8",
			active_row_bg: "#363646",
			panel_bg: "#1f1f28",
			red: "#c34043",
			yellow: "#c0a36e",
			blue: "#7e9cd8",
			green: "#76946a",
			mauve: "#957fb8",
		},
	},
	"kanagawa-lotus": {
		appearance: "light",
		roles: {
			text: "#545464",
			subtext0: "#43436c",
			surface_dim: "#d5cea3",
			accent: "#4d699b",
			active_row_bg: "#d5cea3",
			panel_bg: "#f2ecbc",
			red: "#c84053",
			yellow: "#77713f",
			blue: "#4d699b",
			green: "#6f894e",
			mauve: "#624c83",
		},
	},
	"rose-pine": {
		appearance: "dark",
		roles: {
			text: "#e0def4",
			subtext0: "#c8c5dc",
			surface_dim: "#26233a",
			accent: "#c4a7e7",
			active_row_bg: "#26233a",
			panel_bg: "#191724",
			red: "#eb6f92",
			yellow: "#f6c177",
			blue: "#31748f",
			green: "#31748f",
			mauve: "#c4a7e7",
		},
	},
	"rose-pine-dawn": {
		appearance: "light",
		roles: {
			text: "#464261",
			subtext0: "#797593",
			surface_dim: "#f2e9e1",
			accent: "#907aa9",
			active_row_bg: "#e3d9cf",
			panel_bg: "#faf4ed",
			red: "#b4637a",
			yellow: "#ea9d34",
			blue: "#286983",
			green: "#286983",
			mauve: "#907aa9",
		},
	},
	vesper: {
		appearance: "dark",
		roles: {
			text: "#ffffff",
			subtext0: "#a0a0a0",
			surface_dim: "#101010",
			accent: "#ffc799",
			active_row_bg: "#101010",
			panel_bg: "#1a1a1a",
			red: "#ff8080",
			yellow: "#ffc799",
			blue: "#b0b0b0",
			green: "#99ffe4",
			mauve: "#ffd1a8",
		},
	},
};

/** The 18 built-in themes, every role resolved to a paintable value. */
export const BUILTIN_THEMES: Readonly<Record<string, Theme>> = Object.fromEntries(
	Object.entries(BUILTIN_DEFINITIONS).map(([name, definition]) => [
		name,
		{
			name,
			appearance: definition.appearance,
			roles: Object.fromEntries(
				THEME_ROLES.map((role) => [
					role,
					parseThemeColor(definition.roles[role]) ?? definition.roles[role],
				]),
			) as Record<ThemeRole, ThemeRoleValue>,
		},
	]),
) as Readonly<Record<string, Theme>>;

/**
 * The standalone theme: the fixed dark palette the control plane paints
 * outside herdr.
 *
 * It is the control plane's own theme, defined here like the built-ins, so
 * the standalone plane and the inherited plane are one code path over two
 * themes. The values are the plane's long-standing dark colors.
 */
export const STANDALONE_THEME: Theme = {
	name: "standalone",
	appearance: "dark",
	roles: {
		text: "#c9d1d9",
		subtext0: "#8b949e",
		surface_dim: "#30363d",
		accent: "#58a6ff",
		active_row_bg: "#21262d",
		panel_bg: "#0d1117",
		red: "#f85149",
		yellow: "#d29922",
		blue: "#58a6ff",
		green: "#3fb950",
		mauve: "#bc8cff",
	},
};

/** One TOML value that is a table, else `null`. */
function asTable(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/**
 * The warning an unknown theme name lands on the Message line as.
 *
 * The resolver states it, and the gallery's fallback example reads it from
 * here, so the words the operator sees stand in one place.
 */
export function unknownThemeWarning(name: string): string {
	return `unknown theme name "${name}" in herdr's config; using the built-in default ${DEFAULT_THEME_NAME}`;
}

/** The fallback resolution and the warning that explains it. */
function fallback(reason: string): ThemeResolution {
	return {
		theme: BUILTIN_THEMES[DEFAULT_THEME_NAME],
		warning: `${reason}; using the built-in default ${DEFAULT_THEME_NAME}`,
	};
}

/**
 * Resolve the theme one herdr config states, the way herdr resolves its own.
 *
 * Outside herdr the config text is ignored and the standalone theme stands.
 * Inside herdr, a missing config resolves to the built-in default without a
 * warning, mirroring herdr's own built-in default. A config that names an
 * unknown theme, a config with no `[theme]` section, and an unparseable
 * config all fall back to the built-in default with the reason stated, so
 * the Message line can tell the operator why the pane chose what it chose.
 *
 * With `auto_switch` on, the config's `dark_name` theme stands, falling back
 * to the dark sibling of the stated name: the control plane never guesses
 * the host appearance. `theme.custom` overrides apply per token on top of
 * the base theme, and a value the grammar does not take drops only that
 * token to the base theme value.
 */
export function resolveTheme(configText: string | null, inHerdr: boolean): ThemeResolution {
	if (!inHerdr) return { theme: STANDALONE_THEME, warning: null };
	if (configText === null) return { theme: BUILTIN_THEMES[DEFAULT_THEME_NAME], warning: null };

	let parsed: unknown;
	try {
		parsed = parse(configText);
	} catch {
		return fallback("herdr's config file is not valid TOML");
	}
	const doc = asTable(parsed);
	if (doc === null || doc.theme === undefined) {
		return fallback("herdr's config has no [theme] section");
	}
	const themeSection = asTable(doc.theme);
	if (themeSection === null) {
		return fallback("herdr's config [theme] is not a table");
	}

	const manualName = typeof themeSection.name === "string" ? themeSection.name : DEFAULT_THEME_NAME;
	const siblings = siblingThemeNames(manualName);
	const autoSwitch = themeSection.auto_switch === true;
	const darkName =
		typeof themeSection.dark_name === "string" ? themeSection.dark_name : siblings.dark;
	const selected = autoSwitch ? darkName : manualName;

	const canonical = canonicalThemeName(selected);
	if (canonical === null)
		return { theme: BUILTIN_THEMES[DEFAULT_THEME_NAME], warning: unknownThemeWarning(selected) };

	const base = BUILTIN_THEMES[canonical];
	const roles: Record<ThemeRole, ThemeRoleValue> = { ...base.roles };
	const custom = asTable(themeSection.custom);
	if (custom !== null) {
		for (const role of THEME_ROLES) {
			const value = custom[role];
			if (typeof value !== "string") continue;
			const parsed = parseThemeColor(value);
			if (parsed !== null) roles[role] = parsed;
			// A value the grammar does not take drops only that token: the
			// base theme's value stands for it.
		}
	}
	return { theme: { name: canonical, appearance: base.appearance, roles }, warning: null };
}
