/**
 * The theme isolation every test runs under.
 *
 * The control plane resolves its Theme from the environment at startup: inside
 * herdr it inherits the theme herdr's config names, and a non-empty `NO_COLOR`
 * stands for the no-color presentation (ADR 0024). A frame test that asserts a
 * painted color must therefore not depend on whether the test process itself
 * runs inside a herdr pane or on a terminal that sets `NO_COLOR`.
 *
 * Before every test the theme-relevant environment is cleared and the cached
 * resolution forgotten, so each test starts on the standalone theme in color.
 * A test that needs another resolution - an inherited herdr theme, the
 * no-color presentation - sets its own environment and re-resolves inside the
 * test body, and the next test starts clean again.
 */
import { beforeEach } from "vitest";

import { resetThemeResolution } from "../src/theme-source.ts";

beforeEach(() => {
	delete process.env.HERDR_ENV;
	delete process.env.HERDR_CONFIG_PATH;
	delete process.env.XDG_CONFIG_HOME;
	delete process.env.NO_COLOR;
	resetThemeResolution();
});
