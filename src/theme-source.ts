/**
 * The startup theme resolution the application runs.
 *
 * The pure rules live in the shared theme module; this module owns the one
 * place the resolution touches the machine: the in-herdr fact, the herdr
 * config path, and the read.
 *
 * Inside herdr (herdr marks its child panes with `HERDR_ENV`, and any
 * non-empty value is the mark), the control
 * plane reads herdr's config file and resolves the theme from it, the way
 * herdr finds its own config: a `HERDR_CONFIG_PATH` when the operator set
 * one, else the XDG config home, else the standard home location. The read
 * happens once per process, at startup; a theme change takes effect at the
 * next startup (ADR 0024).
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { resolveTheme, type ThemeResolution } from "./components/shared/theme.ts";

/**
 * True while the process runs inside a herdr pane.
 *
 * The mark is the fact that `HERDR_ENV` is set, not its value: herdr does not
 * promise one, so a value other than "1" still means herdr started this pane.
 */
function inHerdr(env: NodeJS.ProcessEnv): boolean {
	return env.HERDR_ENV !== undefined && env.HERDR_ENV !== "";
}

/**
 * The herdr config file the running herdr reads: the operator's explicit
 * path first, then the XDG config home, then the standard home location.
 */
export function herdrConfigPath(env: NodeJS.ProcessEnv, home: string): string {
	const explicit = env.HERDR_CONFIG_PATH;
	if (explicit !== undefined && explicit !== "") return explicit;
	const configHome =
		env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ""
			? env.XDG_CONFIG_HOME
			: join(home, ".config");
	return join(configHome, "herdr", "config.toml");
}

/** Read one herdr config file; `null` when it is missing or unreadable. */
function readHerdrConfig(env: NodeJS.ProcessEnv, home: string): string | null {
	try {
		return readFileSync(herdrConfigPath(env, home), "utf8");
	} catch {
		return null;
	}
}

let cached: { key: string; resolution: ThemeResolution } | null = null;

/**
 * The theme resolution in force for this process.
 *
 * The resolution is one startup fact: it resolves once per distinct
 * environment and holds for the process's life, so a running plane never
 * re-reads herdr's config. Outside herdr the config file is never read and
 * the standalone theme stands.
 */
export function currentThemeResolution(
	env: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): ThemeResolution {
	const key = [
		env.HERDR_ENV ?? "",
		env.HERDR_CONFIG_PATH ?? "",
		env.XDG_CONFIG_HOME ?? "",
		home,
	].join("\u0000");
	if (cached !== null && cached.key === key) return cached.resolution;
	const resolution = inHerdr(env)
		? resolveTheme(readHerdrConfig(env, home), true)
		: resolveTheme(null, false);
	cached = { key, resolution };
	return resolution;
}

/** Forget the cached resolution: the next call re-reads the environment. */
export function resetThemeResolution(): void {
	cached = null;
}
