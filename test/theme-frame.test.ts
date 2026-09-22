/**
 * Theme inheritance through the real application frame.
 *
 * The frame tests boot the real app through the shared harness with the
 * theme environment set the way herdr sets it: `HERDR_ENV=1` marks the pane
 * and `HERDR_CONFIG_PATH` points at a config file in an isolated directory.
 * The assertions read the colors the frame was drawn with, so a theme the
 * plane claims to inherit must be the theme the frame actually paints.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTheme } from "../src/components/shared/theme.ts";
import {
	awaitFrame,
	cellColors,
	press,
	rgb,
	rowsOf,
	settle,
	spanColorAt,
	startingFaceOf,
	withApp,
} from "./app-harness.ts";

/** Write one herdr config to an isolated directory and mark the process as herdr's pane. */
function herdrConfig(content: string | null): () => void {
	const dir = mkdtempSync(join(tmpdir(), "factory-theme-"));
	process.env.HERDR_ENV = "1";
	process.env.HERDR_CONFIG_PATH = join(dir, "config.toml");
	if (content !== null) writeFileSync(process.env.HERDR_CONFIG_PATH, content);
	return () => rmSync(dir, { recursive: true, force: true });
}

describe("theme inheritance", () => {
	test("inside herdr, the panes paint the theme herdr's config names", async () => {
		const config = '[theme]\nname = "dracula"\n';
		const cleanup = herdrConfig(config);
		// The expected colors come from the theme the config names, resolved
		// through the pure resolver: the frame paints that theme, so the
		// standalone theme's roles are not the palette in force here.
		const theme = resolveTheme(config, true).theme;
		try {
			await withApp(async (setup) => {
				const frame = await settle(setup);
				const rows = rowsOf(frame);
				// The focused list's border wears the theme's accent...
				const borderRow = rows.findIndex((row) => row.includes("┌"));
				expect(spanColorAt(setup, borderRow, "─")).toEqual([0xbd, 0x93, 0xf9]);
				// ...the selected row's marker wears its text...
				const markerRow = rows.findIndex((row) => row.includes("❯ [open]"));
				expect(spanColorAt(setup, markerRow, "❯")).toEqual([0xf8, 0xf8, 0xf2]);
				// ...and the Starting window's face wears the theme's detail
				// tone, in place of the badge it replaced (ADR 0030).
				const faceRow = rows.findIndex((row) => startingFaceOf(row) !== null);
				expect(spanColorAt(setup, faceRow, "starting")).toEqual(rgb(theme.roles.subtext0));
				// An overlay surface paints the theme's own panel role: the Key
				// guide owns its last two rows and paints them on dracula's
				// panel background, not the terminal's default.
				await press(setup, "?", "the Key guide", (f) => f.includes("Key guide"));
				const guide = rowsOf(await settle(setup)).length;
				expect(cellColors(setup, 0, guide - 1).bg).toEqual(rgb(theme.roles.panel_bg));
				expect(cellColors(setup, 0, guide - 2).bg).toEqual(rgb(theme.roles.panel_bg));
				// The panel pin also stands on dracula's own value, so a theme
				// table that moved fails here as well.
				expect(cellColors(setup, 0, guide - 1).bg).toEqual([0x28, 0x2a, 0x36]);
				await press(setup, "escape", "the guide to close", (f) => !f.includes("Key guide"));
			});
		} finally {
			cleanup();
		}
	});

	test("inside herdr, a misnamed theme falls back and says so on the Message line", async () => {
		const config = '[theme]\nname = "frobnicate"\n';
		const cleanup = herdrConfig(config);
		// The fallback the resolver lands on: the frame paints it, so the
		// expected severity color comes from it.
		const theme = resolveTheme(config, true).theme;
		try {
			await withApp(async (setup) => {
				const frame = await awaitFrame(
					setup,
					(f) => f.includes("Warning:"),
					"the fallback warning on the Message line",
				);
				expect(frame).toContain(`unknown theme name "frobnicate" in herdr's config`);
				expect(frame).toContain("using the built-in default catppuccin");
				// The plane paints the fallback theme itself.
				const rows = rowsOf(frame);
				const borderRow = rows.findIndex((row) => row.includes("┌"));
				expect(spanColorAt(setup, borderRow, "─")).toEqual([0x89, 0xb4, 0xfa]);
				// And the Message line's severity color is the fallback theme's:
				// a warning wears the theme's yellow, on the row above the bar.
				const messageRow = rows.length - 2;
				expect(spanColorAt(setup, messageRow, "Warning:")).toEqual(rgb(theme.roles.yellow));
			});
		} finally {
			cleanup();
		}
	});

	test("inside herdr, a light theme name paints the whole plane light", async () => {
		const config = '[theme]\nname = "one-light"\n';
		const cleanup = herdrConfig(config);
		// The expected colors come from the light theme the config names, the
		// same way the dracula case resolves them.
		const theme = resolveTheme(config, true).theme;
		try {
			await withApp(async (setup) => {
				const frame = await settle(setup);
				const rows = rowsOf(frame);
				// The focused list's border wears the light theme's accent, not the
				// standalone dark one...
				const borderRow = rows.findIndex((row) => row.includes("┌"));
				expect(spanColorAt(setup, borderRow, "─")).toEqual([0x40, 0x78, 0xf2]);
				// ...the selected row's marker wears the light theme's dark text...
				const markerRow = rows.findIndex((row) => row.includes("❯ [open]"));
				expect(spanColorAt(setup, markerRow, "❯")).toEqual([0x38, 0x3a, 0x42]);
				// ...and the Starting window's face keeps its written word in
				// the light theme's detail tone. No surface of the plane stays on
				// the old dark palette: the half-light failure the old pin had is
				// gone.
				const faceRow = rows.findIndex((row) => startingFaceOf(row) !== null);
				expect(spanColorAt(setup, faceRow, "starting")).toEqual(rgb(theme.roles.subtext0));
				// The overlay surface is light as well: the Key guide paints on
				// one-light's panel, not the terminal's default.
				await press(setup, "?", "the Key guide", (f) => f.includes("Key guide"));
				const guide = rowsOf(await settle(setup)).length;
				expect(cellColors(setup, 0, guide - 1).bg).toEqual(rgb(theme.roles.panel_bg));
				expect(cellColors(setup, 0, guide - 2).bg).toEqual([0xfa, 0xfa, 0xfa]);
				await press(setup, "escape", "the guide to close", (f) => !f.includes("Key guide"));
			});
		} finally {
			cleanup();
		}
	});

	test("inside herdr, a missing config paints the built-in default without a warning", async () => {
		// The config file is named but absent, the way herdr's own startup
		// starts on its built-in default when its config is missing.
		const cleanup = herdrConfig(null);
		try {
			await withApp(async (setup) => {
				const frame = await settle(setup);
				const borderRow = rowsOf(frame).findIndex((row) => row.includes("┌"));
				expect(spanColorAt(setup, borderRow, "─")).toEqual([0x89, 0xb4, 0xfa]);
				expect(frame).not.toContain("Warning:");
			});
		} finally {
			cleanup();
		}
	});

	test("outside herdr, the standalone theme stands even with a herdr config present", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-theme-"));
		process.env.HERDR_CONFIG_PATH = join(dir, "config.toml");
		writeFileSync(process.env.HERDR_CONFIG_PATH, '[theme]\nname = "dracula"\n');
		try {
			await withApp(async (setup) => {
				const frame = await settle(setup);
				const borderRow = rowsOf(frame).findIndex((row) => row.includes("┌"));
				// The standalone theme's accent, not dracula's: outside herdr
				// the config file is not the control plane's to read.
				expect(spanColorAt(setup, borderRow, "─")).toEqual([0x58, 0xa6, 0xff]);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the no-color presentation", () => {
	test("NO_COLOR paints the frame with no color at all", async () => {
		process.env.NO_COLOR = "1";
		try {
			await withApp(async (setup) => {
				const frame = await settle(setup);
				const rows = rowsOf(frame);
				// The border, the marker, and the badge all paint the terminal's
				// own default: nothing in the frame carries a meaning in color.
				const borderRow = rows.findIndex((row) => row.includes("┌"));
				expect(spanColorAt(setup, borderRow, "─")).toEqual([255, 255, 255]);
				const markerRow = rows.findIndex((row) => row.includes("❯ [open]"));
				expect(spanColorAt(setup, markerRow, "❯")).toEqual([255, 255, 255]);
				// The Starting window's face paints no color either (ADR 0030):
				// the written word stays, the color drops.
				const faceRow = rows.findIndex((row) => startingFaceOf(row) !== null);
				expect(spanColorAt(setup, faceRow, "starting")).toEqual([255, 255, 255]);
				// The words the colors would have carried stay on the screen.
				expect(frame).toContain("Tickets");
				expect(startingFaceOf(frame)).not.toBeNull();
			});
		} finally {
			// The worker's environment is shared with the files that run
			// beside this one: a NO_COLOR left behind paints their frames
			// white for the rest of the run.
			delete process.env.NO_COLOR;
		}
	});
});
