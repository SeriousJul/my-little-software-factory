/**
 * The presentation baseline every shared control uses.
 *
 * A control's meaning never depends on color: each state carries its own
 * written word, and the focus marker is a character as well as a color. The
 * ink a control paints is derived from the Theme in force: inside herdr the
 * control plane inherits the theme herdr's config resolved, outside herdr
 * the standalone theme stands (ADR 0024). The control plane owns the
 * standalone theme's pairs and holds them to the shared control standard -
 * at least 4.5:1 for text and at least 3:1 for an essential control
 * indicator; the pairs an inherited theme provides are painted as-is, not
 * contrast-checked, and that limit is recorded in the verification record.
 *
 * The no-color presentation is the only remaining presentation axis: it
 * works on top of any theme, paints no color at all, and stands when the
 * terminal says so through `NO_COLOR`. The `FACTORY_PRESENTATION` pin and
 * the light/dark presentations are gone: the theme name is the one source
 * of appearance.
 */

import { currentThemeResolution } from "../../theme-source.ts";
import type { TurnEndCause } from "../../turn-log.ts";
import type { Theme } from "./theme.ts";

/**
 * One text role and the background it is painted on.
 *
 * `fg` is the painted foreground; `null` paints no color at all, which is
 * the whole of the no-color presentation and the effect of a role that
 * resolved to `reset`. `on` is the surface the role paints against: the
 * theme's value for the surface, or `default` for the terminal's own.
 */
export interface InkRole {
	/** The painted foreground. `null` paints no color at all. */
	fg: string | null;
	/** The background this role paints on. */
	on: string;
}

/** The colors and written words one shared control state carries. */
export interface ControlInk {
	/** Field text and row labels, on the surface the overlay paints. */
	text: InkRole;
	/** The focused field's text and its label. Bold carries the emphasis the bright-text role used to. */
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
	/** The terminal default, stated so a surface knows what it paints on. */
	defaultBackground: string;
}

/** The minimum contrast the standard requires for text. */
export const MIN_TEXT_CONTRAST = 4.5;
/** The minimum contrast the standard requires for an essential indicator. */
export const MIN_INDICATOR_CONTRAST = 3;

/** A role's foreground in one theme: its color, or no color for `reset`. */
function foreground(roles: Theme["roles"], role: keyof Theme["roles"]): string | null {
	return roles[role] === "reset" ? null : roles[role];
}

/** A role's surface in one theme: its color, or the terminal default for `reset`. */
function surface(roles: Theme["roles"], role: keyof Theme["roles"]): string {
	return roles[role] === "reset" ? "default" : roles[role];
}

/**
 * The ink one theme paints with.
 *
 * The theme's roles stand for the control's roles: text on the panel
 * surface, the accent as the indicator, the state colors where the states
 * read. A role the theme resolves to `reset` paints no color, so the
 * terminal's own default shows through where the theme says so.
 */
export function inkForTheme(theme: Theme): ControlInk {
	const roles = theme.roles;
	return {
		text: { fg: foreground(roles, "text"), on: surface(roles, "panel_bg") },
		focusedText: { fg: foreground(roles, "text"), on: surface(roles, "panel_bg") },
		detail: { fg: foreground(roles, "subtext0"), on: surface(roles, "panel_bg") },
		error: { fg: foreground(roles, "red"), on: surface(roles, "panel_bg") },
		warning: { fg: foreground(roles, "yellow"), on: surface(roles, "panel_bg") },
		indicator: { fg: foreground(roles, "accent"), on: surface(roles, "panel_bg") },
		selectionText: { fg: foreground(roles, "panel_bg"), on: surface(roles, "accent") },
		selectionBackground: { fg: foreground(roles, "accent"), on: surface(roles, "panel_bg") },
		focusedField: { fg: foreground(roles, "text"), on: surface(roles, "active_row_bg") },
		surface: { fg: foreground(roles, "text"), on: surface(roles, "panel_bg") },
		defaultBackground: surface(roles, "panel_bg"),
	};
}

/**
 * The no-color presentation.
 *
 * Every role paints no foreground and no background, so the terminal's own
 * colors stand: nothing is carried by a color, and the labels, the focus
 * marker, and the written state words are the whole message. It works on
 * top of any theme, because it asks the theme for nothing.
 */
export const NO_COLOR_INK: ControlInk = {
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

/**
 * Whether the terminal asks for the no-color presentation.
 *
 * The convention is `NO_COLOR`: set to a non-empty value and the plane
 * paints no color at all, on top of whichever theme the environment
 * resolves.
 */
export function noColorPresentation(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.NO_COLOR !== undefined && env.NO_COLOR !== "";
}

/** The presentation the control plane draws in: the no-color ink, else the ink of the Theme in force. */
export function controlInk(): ControlInk {
	if (noColorPresentation()) return NO_COLOR_INK;
	return inkForTheme(currentThemeResolution().theme);
}

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

/**
 * The line that states why a settled turn ended: `no-turn` states that the
 * turn never started, and every other cause states the turn ended, with the
 * agent's own text when it has one (ADR 0017).
 */
export function turnEndCauseLine(cause: TurnEndCause, detail: string): string {
	if (cause === "no-turn") return "The turn never started";
	return detail === "" ? `Turn ended ${cause}` : `Turn ended ${cause}: ${detail}`;
}

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
 * declared theme cannot pass by restating the threshold it is judged on.
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
 * Every pair in one ink that fails the standard's contrast.
 *
 * The check holds the control plane's own ink to the standard. An ink that
 * paints no color for a role, or against the terminal default, has no pair
 * to measure: the written information is the whole requirement there, and
 * an inherited theme's pairs are painted as the theme states them.
 */
export function contrastFailures(
	ink: ControlInk,
): Array<{ role: string; ratio: number; required: number }> {
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
