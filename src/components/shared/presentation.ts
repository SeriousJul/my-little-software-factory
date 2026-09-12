/**
 * The presentation baseline every shared control uses.
 *
 * A control's meaning never depends on color: each state carries its own
 * written word, and the focus marker is a character as well as a color. The
 * palettes below hold the tested pairs the shared control standard requires -
 * at least 4.5:1 for text and at least 3:1 for an essential control
 * indicator - so a surface cannot invent a dimmer combination by picking
 * colors by hand. The automated check recomputes every ratio from the hex
 * pairs with the WCAG formula; the numbers below are what the library paints,
 * not what the check trusts.
 *
 * The palette is one fact the control plane reads at startup. A terminal that
 * reports a light color scheme gets the light pairs; the rest keep the dark
 * pairs the plane has always used. `FACTORY_PRESENTATION` pins the choice for
 * a visual check or an automated test, and `mono` drops color for an operator
 * who wants the written information alone.
 */

/** The presentations the shared controls draw. */
export type Presentation = "dark" | "light" | "mono";

/**
 * One text role and the background it is measured against.
 *
 * `background` is the surface the pair is tested on: a control-plane overlay
 * paints its own `bg` cells, and a base pane paints no background at all, so
 * its text is measured against the terminal's default. The automated check
 * reads the same two fields the library paints from.
 */
export interface InkRole {
	/** The painted foreground. `null` paints no color at all. */
	fg: string | null;
	/** The background this pair is measured against. */
	on: string;
}

/** The colors and written words one shared control state carries. */
export interface ControlInk {
	/** Field text and row labels, on the surface the overlay paints. */
	text: InkRole;
	/** The focused field's text and its label. */
	focusedText: InkRole;
	/** A hint or a state word the operator can still act on. */
	detail: InkRole;
	/** An error, and the reason a control refused. */
	error: InkRole;
	/** A value the target cannot take, and a size warning. */
	warning: InkRole;
	/** A border, a focus marker, and a caret: an essential indicator. */
	indicator: InkRole;
	/** The foreground a keyboard selection paints over field text. */
	selectionText: InkRole;
	/** The background a keyboard selection paints. */
	selectionBackground: InkRole;
	/** The background a focused field paints its text on. */
	focusedField: InkRole;
	/** The surface an overlay paints its box on. */
	surface: InkRole;
	/** The terminal default, stated so a pair can be measured against it. */
	defaultBackground: string;
}

/** The minimum contrast the standard requires for text. */
export const MIN_TEXT_CONTRAST = 4.5;
/** The minimum contrast the standard requires for an essential indicator. */
export const MIN_INDICATOR_CONTRAST = 3;

const DARK: ControlInk = {
	text: { fg: "#c9d1d9", on: "#0d1117" },
	focusedText: { fg: "#e6edf3", on: "#0d1117" },
	detail: { fg: "#8b949e", on: "#0d1117" },
	error: { fg: "#f85149", on: "#0d1117" },
	warning: { fg: "#d29922", on: "#0d1117" },
	indicator: { fg: "#58a6ff", on: "#0d1117" },
	selectionText: { fg: "#0d1117", on: "#58a6ff" },
	selectionBackground: { fg: "#58a6ff", on: "#0d1117" },
	focusedField: { fg: "#e6edf3", on: "#21262d" },
	surface: { fg: "#c9d1d9", on: "#0d1117" },
	defaultBackground: "#0d1117",
};

const LIGHT: ControlInk = {
	text: { fg: "#24292f", on: "#f6f8fa" },
	focusedText: { fg: "#010409", on: "#f6f8fa" },
	detail: { fg: "#57606a", on: "#f6f8fa" },
	error: { fg: "#a40e26", on: "#f6f8fa" },
	warning: { fg: "#7a4b00", on: "#f6f8fa" },
	indicator: { fg: "#0969da", on: "#f6f8fa" },
	selectionText: { fg: "#f6f8fa", on: "#0969da" },
	selectionBackground: { fg: "#0969da", on: "#f6f8fa" },
	focusedField: { fg: "#010409", on: "#eaeef2" },
	surface: { fg: "#1f2328", on: "#f6f8fa" },
	defaultBackground: "#f6f8fa",
};

/**
 * The no-color presentation.
 *
 * Every role paints no foreground and no background, so the terminal's own
 * colors stand: nothing is carried by a color, and the labels, the focus
 * marker, and the written state words are the whole message.
 */
const MONO: ControlInk = {
	text: { fg: null, on: "default" },
	focusedText: { fg: null, on: "default" },
	detail: { fg: null, on: "default" },
	error: { fg: null, on: "default" },
	warning: { fg: null, on: "default" },
	indicator: { fg: null, on: "default" },
	selectionText: { fg: null, on: "default" },
	selectionBackground: { fg: null, on: "default" },
	focusedField: { fg: null, on: "default" },
	surface: { fg: null, on: "default" },
	defaultBackground: "default",
};

const PALETTES: Record<Presentation, ControlInk> = {
	dark: DARK,
	light: LIGHT,
	mono: MONO,
};

/** The written word for a state, so removing color removes nothing. */
export const STATE_WORDS = {
	loading: "(loading...)",
	empty: "(empty)",
	unset: "(unset)",
	noModels: "(no models available)",
	noMatch: "(no match)",
	unavailable: "(unavailable)",
	notSaved: "not saved across restarts",
} as const;

/** The focus marker a row carries: a character first, a color as well. */
export const FOCUS_MARKER = "❯ ";
/** The cells the marker column holds. */
export const MARKER_WIDTH = 2;

/** The marker column's text for one row. */
export function markerText(focused: boolean): string {
	return focused ? FOCUS_MARKER : " ".repeat(MARKER_WIDTH);
}

/**
 * The cells a control's own written note holds: its marker, its label column,
 * and its value column.
 *
 * A surface with room beside those columns names a wider note instead, so a
 * reason is cut by the box the operator reads and not by the column the value
 * happens to need.
 */
export function ownNoteCells(labelWidth: number, valueWidth: number): number {
	return MARKER_WIDTH + labelWidth + valueWidth;
}

/** One sRGB channel's linear value, as the WCAG relative luminance defines it. */
function linearChannel(byte: number): number {
	const channel = byte / 255;
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** The relative luminance of a `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
	const red = Number.parseInt(hex.slice(1, 3), 16);
	const green = Number.parseInt(hex.slice(3, 5), 16);
	const blue = Number.parseInt(hex.slice(5, 7), 16);
	return 0.2126 * linearChannel(red) + 0.7152 * linearChannel(green) + 0.0722 * linearChannel(blue);
}

/**
 * The WCAG contrast ratio of two colors.
 *
 * The shared check recomputes this from the pairs the library paints, so a
 * declared palette cannot pass by restating the threshold it is judged on.
 */
export function contrastRatio(one: string, other: string): number {
	const first = relativeLuminance(one);
	const second = relativeLuminance(other);
	const lighter = Math.max(first, second);
	const darker = Math.min(first, second);
	return (lighter + 0.05) / (darker + 0.05);
}

/** The roles a control's text must clear at 4.5:1. */
export const TEXT_ROLES: readonly (keyof ControlInk)[] = [
	"text",
	"focusedText",
	"detail",
	"error",
	"warning",
	"selectionText",
	"surface",
];

/** The roles that carry an essential indicator, and so clear 3:1. */
export const INDICATOR_ROLES: readonly (keyof ControlInk)[] = [
	"indicator",
	"selectionBackground",
	"focusedField",
];

/**
 * Every pair in one presentation that fails the standard's contrast.
 *
 * The mono presentation paints no colors at all, so it has no pair to measure:
 * its written information is the whole requirement.
 */
export function contrastFailures(
	presentation: Presentation,
): Array<{ role: string; ratio: number; required: number }> {
	const ink = PALETTES[presentation];
	if (presentation === "mono") return [];
	const failures: Array<{ role: string; ratio: number; required: number }> = [];
	for (const role of [...TEXT_ROLES, ...INDICATOR_ROLES]) {
		const pair = ink[role] as InkRole;
		if (pair.fg === null || pair.on === "default") continue;
		const required = TEXT_ROLES.includes(role) ? MIN_TEXT_CONTRAST : MIN_INDICATOR_CONTRAST;
		const ratio = contrastRatio(pair.fg, pair.on);
		if (ratio < required) failures.push({ role, ratio, required });
	}
	return failures;
}

/** The presentation the control plane draws in. */
export function currentPresentation(themeMode: "dark" | "light" | null): Presentation {
	const pinned = process.env.FACTORY_PRESENTATION;
	if (pinned === "dark" || pinned === "light" || pinned === "mono") return pinned;
	return themeMode === "light" ? "light" : "dark";
}

/** The palette of one presentation. */
export function inkFor(presentation: Presentation): ControlInk {
	return PALETTES[presentation];
}

/** The palette in force for a surface. */
export function controlInk(themeMode: "dark" | "light" | null = null): ControlInk {
	return inkFor(currentPresentation(themeMode));
}
