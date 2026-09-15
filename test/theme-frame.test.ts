/**
 * Theme inheritance through the real application frame.
 *
 * The frame tests boot the real app through the shared harness with the
 * theme environment set the way herdr sets it: `HERDR_ENV=1` marks the pane
 * and `HERDR_CONFIG_PATH` points at a config file in an isolated directory.
 * The assertions read the colors the frame was drawn with, so a theme the
 * plane claims to inherit must be the theme the frame actually paints.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
	awaitFrame,
	cellColors,
	press,
	rgb,
	roleColor,
	rowsOf,
	settle,
	spanColorAt,
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
		const cleanup = herdrConfig('[theme]\nname = "dracula"\n');
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
				// ...and the state badge wears its yellow.
				const badgeRow = rows.findIndex((row) => row.includes("[handed-off]"));
				expect(spanColorAt(setup, badgeRow, "[handed-off]")).toEqual([0xf1, 0xfa, 0x8c]);
				// An overlay surface paints the theme's own panel role: the Key
				// guide owns its last two rows and paints them on dracula's
				// panel background, not the terminal's default.
				await press(setup, "?", "the Key guide", (f) => f.includes("Key guide"));
				const guide = rowsOf(await settle(setup)).length;
				expect(cellColors(setup, 0, guide - 1).bg).toEqual(rgb(roleColor("panel_bg")));
				expect(cellColors(setup, 0, guide - 2).bg).toEqual(rgb(roleColor("panel_bg")));
				expect(cellColors(setup, 0, guide - 1).bg).toEqual([0x28, 0x2a, 0x36]);
				await press(setup, "escape", "the guide to close", (f) => !f.includes("Key guide"));
			});
		} finally {
			cleanup();
		}
	});

	test("inside herdr, a misnamed theme falls back and says so on the Message line", async () => {
		const cleanup = herdrConfig('[theme]\nname = "frobnicate"\n');
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
				expect(spanColorAt(setup, messageRow, "Warning:")).toEqual(rgb(roleColor("yellow")));
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
		await withApp(async (setup) => {
			const frame = await settle(setup);
			const rows = rowsOf(frame);
			// The border, the marker, and the badge all paint the terminal's
			// own default: nothing in the frame carries a meaning in color.
			const borderRow = rows.findIndex((row) => row.includes("┌"));
			expect(spanColorAt(setup, borderRow, "─")).toEqual([255, 255, 255]);
			const markerRow = rows.findIndex((row) => row.includes("❯ [open]"));
			expect(spanColorAt(setup, markerRow, "❯")).toEqual([255, 255, 255]);
			const badgeRow = rows.findIndex((row) => row.includes("[handed-off]"));
			expect(spanColorAt(setup, badgeRow, "[handed-off]")).toEqual([255, 255, 255]);
			// The words the colors would have carried stay on the screen.
			expect(frame).toContain("Tickets");
			expect(frame).toContain("[handed-off]");
		});
	});
});
