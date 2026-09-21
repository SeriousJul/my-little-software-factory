/**
 * Generate the documentation homepage's hero shot: the control plane
 * running in a herdr workspace.
 *
 * The capture drives an isolated herdr: a fresh server in a temporary
 * directory with its own socket and home, so the operator's live herdr
 * session is never touched. The control plane runs in one pane of a
 * workspace, the world outside it comes from the same fixture the doc
 * screenshots use (the fixture's stub executables stand first on the
 * panes' PATH, so the plane's data stays deterministic), and an attached
 * herdr client renders the workspace. The client's screen renders with
 * the same ANSI renderer as the doc screenshots.
 *
 * This shot is refreshed by hand (`npm run hero`). It is not in the
 * drift test: herdr's chrome belongs to herdr, and it changes when
 * herdr changes.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { openPty } from "../test/executable-pty.ts";
import { parseScreen, renderPng } from "./ansi-render.ts";
import { buildFixture } from "./screenshot-fixture.ts";

type Grid = ReturnType<typeof parseScreen>;

function preview(out: Buffer): string {
	const text = out.toString("utf8");
	return text.length > 2000 ? `...${text.slice(-2000)}` : text;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONTROLLER_BIN = join(ROOT, "bin", "factory.mjs");
const OUT = join(ROOT, "docs", "public", "hero.png");

/** The screen the hero shot shows: wide enough for two panes. */
const SCREEN = { cols: 256, rows: 56 } as const;

/** Resolve the real herdr binary from the operator's PATH. */
function herdrBin(): string {
	const out = spawnSync("which", ["herdr"]).stdout.toString().trim();
	if (out === "") throw new Error("hero: herdr is not on the PATH; install herdr first");
	return out;
}

/** The fake agent's pane: a static session screen that stays alive. */
const AGENT_PANE_SCRIPT = `#!/bin/sh
# Clear the pane so the shot shows the session, not the launch line.
printf '\\033[2J\\033[H'
printf '%s\\n' \\
	"pi  anthropic/claude-sonnet-4-5" \\
	"" \\
	"Reading the webhook handler to find the delivery path." \\
	"  read_file src/webhooks/handler.ts" \\
	"  read_file src/webhooks/queue.ts" \\
	"Adding a retry queue with a bounded backoff:" \\
	"  edit_file src/webhooks/queue.ts" \\
	"  edit_file src/webhooks/handler.ts" \\
	"Writing the delivery tests." \\
	"  write_file src/webhooks/queue.test.ts"
sleep 3600
`;

async function main(): Promise<void> {
	const bin = herdrBin();
	const tmp = mkdtempSync(join(tmpdir(), "mlsf-hero-"));
	const home = join(tmp, "home");
	mkdirSync(home, { recursive: true });
	// The isolated namespace: its own socket and home, nothing of the
	// operator's session.
	const isoEnv: Record<string, string> = {
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_STATE_HOME: join(home, ".state"),
		XDG_DATA_HOME: join(home, ".data"),
		HERDR_SOCKET_PATH: join(tmp, "herdr.sock"),
		TERM: "xterm-256color",
	};
	// The server's PATH puts the fixture's stub executables first, so
	// every process a pane launches resolves the stubs, not the real
	// world. The CLI calls this script makes use the operator's PATH.
	const serverEnv = {
		...isoEnv,
		PATH: `${join(tmp, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
	};

	const fixture = buildFixture(tmp);
	// buildFixture puts the stubs in <fixture>/bin; the server PATH
	// expects <tmp>/bin. Rebuild the PATH over the fixture's own bin.
	serverEnv.PATH = `${join(fixture, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`;
	writeFileSync(join(fixture, "agent-pane.sh"), AGENT_PANE_SCRIPT);
	// A fresh herdr home shows a first-run onboarding modal on the first
	// client attach. Suppress it so the shot is the workspace, not the tour.
	// Name the theme explicitly: inside herdr the plane reads this same config
	// to inherit the theme (ADR 0024), and a config with no [theme] section
	// falls back with a warning on its Message line.
	const herdrConfigDir = join(home, ".config", "herdr");
	mkdirSync(herdrConfigDir, { recursive: true });
	writeFileSync(
		join(herdrConfigDir, "config.toml"),
		'onboarding = false\n\n[theme]\nname = "catppuccin"\n',
	);

	const serverLog = openSync(join(tmp, "herdr-server.log"), "a");
	const server = spawn(bin, ["server"], {
		env: serverEnv,
		stdio: ["ignore", serverLog, serverLog],
	});
	let client: Awaited<ReturnType<typeof openPty>> = null;
	let paneA = "";
	let paneB = "";
	let failed = false;
	try {
		await waitForServer(bin, isoEnv);
		const rootPane = await cliJson(bin, isoEnv, [
			"workspace",
			"create",
			"--cwd",
			fixture,
			"--label",
			"my-little-software-factory",
		]);
		paneA = rootPane.result.root_pane.pane_id as string;
		const split = await cliJson(bin, isoEnv, [
			"pane",
			"split",
			paneA,
			"--direction",
			"right",
			"--ratio",
			"0.74",
		]);
		paneB = split.result.pane.pane_id as string;

		// Attach the client first, so the panes size to its window
		// before the app renders.
		client = await openPty(
			bin,
			[],
			{ ...isoEnv, PATH: process.env.PATH ?? "/usr/bin:/bin" },
			{
				size: { cols: SCREEN.cols, rows: SCREEN.rows },
			},
		);
		if (client === null) throw new Error("hero: this platform cannot open a PTY");
		await client.waitFor(
			(out) => out.toString("utf8").includes("my-little-software-factory"),
			"the workspace to appear in the client",
			30000,
		);

		await cli(bin, isoEnv, ["pane", "run", paneB, "sh", join(fixture, "agent-pane.sh")]);
		await cli(bin, isoEnv, [
			"pane",
			"run",
			paneA,
			process.execPath,
			CONTROLLER_BIN,
			"--config",
			join(fixture, "config.toml"),
		]);
		// Wait for the ticket header, not a ticket title: the list column
		// truncates titles, and the Detail pane shows the focused ticket,
		// so a title string is not a reliable settle signal. The herdr client
		// is a full-screen TUI: it redraws with cursor moves and SGR codes
		// between characters, so a multi-word string never appears contiguous
		// in the raw byte stream. Settle on the parsed grid instead.
		const header = "open: 1  running: 1  awaiting: 1";
		const hasHeader = (grid: Grid): boolean =>
			grid.some((row) =>
				row
					.map((c) => c.char)
					.join("")
					.includes(header),
			);
		const headerDeadline = Date.now() + 60000;
		for (;;) {
			if (hasHeader(parseScreen(client.output(), SCREEN.cols, SCREEN.rows))) break;
			if (Date.now() >= headerDeadline) {
				throw new Error(
					`timed out waiting for the Main view to render in the pane\ncaptured output:\n${preview(client.output())}`,
				);
			}
			await sleep(250);
		}
		// The client redraws its chrome on a timer, so the byte stream never
		// rests. Settle on the parsed screen grid instead: capture, re-capture
		// once the grid stops changing, and render that.
		let last = gridKey(client.output());
		let stableSince = Date.now();
		const deadline = Date.now() + 30000;
		for (;;) {
			await sleep(250);
			const key = gridKey(client.output());
			if (key !== last) {
				last = key;
				stableSince = Date.now();
			} else if (Date.now() - stableSince >= 1200) {
				break;
			}
			if (Date.now() >= deadline) break;
		}
		const grid = parseScreen(client.output(), SCREEN.cols, SCREEN.rows);
		mkdirSync(dirname(OUT), { recursive: true });
		writeFileSync(OUT, renderPng(grid));
		console.log(`hero: wrote ${OUT}`);
	} catch (err) {
		failed = true;
		for (const [label, pane] of [
			["plane", paneA],
			["agent", paneB],
		] as const) {
			if (pane === "") continue;
			try {
				const out = spawnSync(bin, ["pane", "read", pane], { env: isoEnv }).stdout.toString();
				console.error(`--- ${label} pane ${pane} ---\n${out.slice(-2000)}`);
			} catch {
				// The pane is gone; the server is already down.
			}
		}
		try {
			console.error(
				`--- herdr server log ---\n${readFileSync(join(tmp, "herdr-server.log"), "utf8").slice(-2000)}`,
			);
		} catch {
			// No log yet.
		}
		throw err;
	} finally {
		client?.dispose();
		spawnSync(bin, ["server", "stop"], { env: isoEnv });
		if (server.exitCode === null && server.signalCode === null) {
			server.kill("SIGKILL");
		}
		if (failed) {
			console.error(`hero: kept ${tmp} for inspection`);
		} else {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
}

/** A fingerprint of the parsed screen, to tell a settled frame from a redraw. */
function gridKey(frame: Buffer): string {
	return parseScreen(frame, SCREEN.cols, SCREEN.rows)
		.flatMap((row) => row.map((cell) => cell.char))
		.join("");
}

/** Wait until the isolated server answers its socket. */
async function waitForServer(bin: string, env: Record<string, string>): Promise<void> {
	const deadline = Date.now() + 30000;
	for (;;) {
		const out = spawnSync(bin, ["status", "server"], { env }).stdout.toString();
		if (out.includes("status: running")) return;
		if (Date.now() >= deadline) throw new Error("hero: the herdr server did not start");
		await sleep(250);
	}
}

/** Run one herdr CLI command in the isolated namespace and ignore its output. */
function cli(bin: string, env: Record<string, string>, args: string[]): void {
	const out = spawnSync(bin, args, { env, encoding: "utf8" });
	if (out.status !== 0) {
		throw new Error(`hero: herdr ${args.join(" ")} failed: ${out.stdout}\n${out.stderr}`);
	}
}

/** Run one herdr CLI command and parse its JSON result. */
async function cliJson(
	bin: string,
	env: Record<string, string>,
	args: string[],
): Promise<{ result: Record<string, unknown> }> {
	const out = spawnSync(bin, args, { env, encoding: "utf8" });
	if (out.status !== 0) {
		throw new Error(`hero: herdr ${args.join(" ")} failed: ${out.stdout}\n${out.stderr}`);
	}
	return JSON.parse(out.stdout) as { result: Record<string, unknown> };
}

await main();
