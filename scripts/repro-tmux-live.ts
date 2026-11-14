/**
 * Run the real control plane inside tmux (a battle-tested VT) with the repo
 * fixture, drive it to the Live view on the running ticket, and stream long
 * lines from the fixture agent pane. The pane is captured every 100ms while
 * the stream grows. The Live view is bottom-pinned and follows the tail, so
 * a healthy screen shows a contiguous run of the newest stream lines. The
 * check extracts every "L<number>" line start from the body and requires the
 * numbers to be strictly increasing by one, ending near the stream tail. A
 * duplicate, a gap, or an out-of-order number is the interleaved/stale-row
 * artifact the user reported.
 *
 * The script also records the exact bytes the app writes to the pane
 * (tmux pipe-pane) to a file it prints at the end. Decoding the recorded
 * synchronized frames shows the renderer itself emits the corrupted rows:
 * the corruption is in OpenTUI's native row-update path, not in tmux, the
 * fixture, or the byte transport. See the shared-control verification
 * record for the measurements.
 *
 * Usage: bun scripts/repro-tmux-live.ts
 * Requires: tmux on PATH.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { buildFixture } from "./screenshot-fixture.ts";

const COLS = 200;
const ROWS = 50;
const SESSION = "mlsf-tmux-drift";
const RUN_MS = 40000;

const root = tmpdir();
const fixture = buildFixture(root);
const streamFile = join(fixture, "stream.txt");
writeFileSync(streamFile, "");

// Replace the herdr stub with one whose pane-2 reads the growing stream
// file. Generated lines hold only "L<digits>" plus lowercase words, so no
// JSON escaping beyond newlines is needed.
const herdrStub = join(fixture, "bin", "herdr");
const stub = [
	"#!/bin/sh",
	`dir='${fixture}'`,
	'[ "$1" = "agent" ] || exit 1',
	'case "$2" in',
	"list)",
	'  printf \'%s\' \'{"result":{"agents":[{"pane_id":"pane-2","tab_id":"tab-2","workspace_id":"ws-2","agent":"pi","checkout_path":"/home/seriousjul/src/my-little-software-factory","agent_status":"working"}]}}\'',
	"  ;;",
	"read)",
	'  case "$3" in',
	"  pane-2)",
	'    out=""',
	'    if [ -f "$dir/stream.txt" ]; then',
	'      while IFS= read -r line || [ -n "$line" ]; do',
	'        [ -n "$out" ] && out="$out\\\\n"',
	'        out="$out$line"',
	'      done < "$dir/stream.txt"',
	"    fi",
	'    printf \'%s\' "{\\"result\\":{\\"output\\":\\"$out\\"}}"',
	"    ;;",
	"  *)",
	"    exit 1",
	"    ;;",
	"esac",
	"  ;;",
	"wait)",
	"  # A live wait on a working agent blocks; the plane's timeout ends it.",
	"  sleep 100",
	"  ;;",
	"*)",
	"  exit 1",
	"  ;;",
	"esac",
	"",
].join("\n");
writeFileSync(herdrStub, stub);
chmodSync(herdrStub, 0o755);

// Deterministic line generator: 120..249 cells so some lines wrap in the
// pane. The file keeps the newest 100 lines only.
const words =
	"the quick brown fox jumps over a lazy dog near the river bank and back again to the meadow by the old stone bridge where the willows grow low and the water runs cold".split(
		" ",
	);
let n = 0;
const gen = setInterval(() => {
	let line = `L${n} `;
	let w = line.length;
	const target = 120 + (n % 130);
	while (w < target) {
		const word = words[(n * 7 + w) % words.length];
		if (w + 1 + word.length > target + 40) break;
		line += `${word} `;
		w += 1 + word.length;
	}
	let prev: string[] = [];
	try {
		prev = readFileSync(streamFile, "utf8")
			.split("\n")
			.filter((l) => l !== "");
	} catch {
		prev = [];
	}
	writeFileSync(streamFile, [...prev, line].slice(-100).join("\n"));
	n += 1;
}, 80);

function tmux(args: string[]): string {
	const r = spawnSync("tmux", args, { encoding: "utf8" });
	return (r.stdout ?? "") + (r.stderr ?? "");
}

tmux(["kill-session", "-t", SESSION]);
const boot = tmux([
	"new-session",
	"-d",
	"-s",
	SESSION,
	"-x",
	String(COLS),
	"-y",
	String(ROWS),
	`env HOME=${fixture} XDG_CONFIG_HOME=${join(fixture, ".config")} XDG_STATE_HOME=${join(fixture, ".state")} XDG_DATA_HOME=${join(fixture, ".data")} XDG_CACHE_HOME=${join(fixture, ".cache")} PATH=${join(fixture, "bin")}:$PATH TERM=xterm-256color MLSF_REPRO_DIR=${fixture} HERDR_ENV=mlsf-repro HERDR_PANE_ID= HC_TERMINAL_ID= HC_SCOPE= HC_TERMINAL_SOCKET= ${process.execPath} ${join(process.cwd(), "bin/factory.mjs")} --config ${join(fixture, "config.toml")}`,
]);
if (boot.includes("can't find") || boot.includes("no server running")) {
	throw new Error(`tmux failed: ${boot}`);
}

// Wait for the main view, then open the Live view on the running ticket.
let sawMain = false;
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
	const cap = tmux(["capture-pane", "-p", "-t", SESSION]);
	if (/open: \d+ {2}running: \d+ {2}awaiting: \d+/.test(cap)) {
		sawMain = true;
		break;
	}
	await sleep(200);
}
if (!sawMain) {
	console.error("main view never appeared");
	tmux(["kill-session", "-t", SESSION]);
	clearInterval(gen);
	process.exit(2);
}
// The in-flight ticket's row, named by its title: the fixture's list
// carries the repository group headers, so the row's position is not a
// constant. Step the keyboard onto it the way the screenshot walk does,
// reading the cursor row from the same frame.
async function cursorRow(): Promise<string> {
	const cap = tmux(["capture-pane", "-p", "-t", SESSION]);
	const rows = cap.split("\n");
	const border = rows.findIndex((l) => l.includes("─❯"));
	if (border === -1) return "";
	for (let i = border + 1; i < rows.length; i++) {
		if (rows[i].startsWith("└")) break;
		if (rows[i].includes("❯")) return rows[i].replace("❯", " ").trim();
	}
	return "";
}
let onInFlightRow = false;
for (let i = 0; i < 10 && !onInFlightRow; i++) {
	if ((await cursorRow()).includes("Retry failed webhook")) {
		onInFlightRow = true;
		break;
	}
	tmux(["send-keys", "-t", SESSION, "j"]);
	await sleep(150);
}
if (!onInFlightRow) {
	console.error("could not reach the in-flight ticket's row");
	tmux(["kill-session", "-t", SESSION]);
	clearInterval(gen);
	process.exit(2);
}
// The row's state lags the boot: Observation settles it on [running] when
// it matches the ticket's pane, and only a running row opens the Live view.
// Wait for the badge before the Enter, or the key is refused.
let sawRunning = false;
const runningDeadline = Date.now() + 20000;
while (Date.now() < runningDeadline) {
	const cap = tmux(["capture-pane", "-p", "-t", SESSION]);
	const row = cap
		.split("\n")
		.some((l) => l.includes("Retry failed webhook") && l.includes("running"));
	if (row) {
		sawRunning = true;
		break;
	}
	await sleep(200);
}
if (!sawRunning) {
	console.error("the in-flight ticket never settled on [running]");
	tmux(["kill-session", "-t", SESSION]);
	clearInterval(gen);
	process.exit(2);
}
tmux(["send-keys", "-t", SESSION, "Enter"]);
await sleep(400);
let sawLive = false;
const liveDeadline = Date.now() + 20000;
while (Date.now() < liveDeadline) {
	const cap = tmux(["capture-pane", "-p", "-t", SESSION]);
	if (cap.includes("Live:")) {
		sawLive = true;
		break;
	}
	await sleep(200);
}
if (!sawLive) {
	console.error("live view never opened");
	tmux(["kill-session", "-t", SESSION]);
	clearInterval(gen);
	process.exit(2);
}
console.error("live view open; capturing for", RUN_MS / 1000, "s");

// Record the exact bytes the app writes to the pane, for offline analysis.
const recording = `/tmp/pane-record-${Date.now()}.bin`;
tmux(["pipe-pane", "-o", "-t", SESSION, `cat >> ${recording}`]);

const start = Date.now();
let captures = 0;
let checked = 0;
let smeared = 0;
let exampleShown = 0;
while (Date.now() - start < RUN_MS) {
	await sleep(100);
	const cap = tmux(["capture-pane", "-p", "-t", SESSION]);
	captures += 1;
	const rows = cap.split("\n");
	const ctx = rows.findIndex((r) => r.includes("· implement ·"));
	const act = rows.findIndex((r) => r.includes("Goto"));
	if (ctx < 0 || act < 0 || act - ctx < 5) continue;
	const body = rows.slice(ctx + 1, act).map((r) => {
		const left = r.indexOf("│") + 1;
		const right = r.lastIndexOf("│");
		// The Live view's body stands inside two box levels; drop the inner
		// border so a line start reads as the stream line it is.
		return r
			.slice(left, right)
			.replace(/^\s*│\s*/, "")
			.trim();
	});
	// Every line start in the body, in screen order.
	const nums: number[] = [];
	for (const row of body) {
		const m = row.match(/^L(\d+)\s/);
		if (m !== null) nums.push(Number(m[1]));
	}
	if (nums.length < 10) continue;
	checked += 1;
	// Contiguity: strictly increasing by one, no duplicate or gap.
	let contiguous = true;
	for (let i = 1; i < nums.length; i += 1) {
		if (nums[i] !== nums[i - 1] + 1) {
			contiguous = false;
			break;
		}
	}
	// Tail-follow: the last visible line is within a bounded lag of the
	// stream's newest line (the one-second refresh plus read latency).
	const newest = n - 1;
	const tailLag = newest - nums[nums.length - 1];
	const followsTail = tailLag >= 0 && tailLag <= 25;
	if (!contiguous || !followsTail) {
		smeared += 1;
		if (exampleShown < 3) {
			exampleShown += 1;
			const tag = `${Date.now()}-${captures}`;
			writeFileSync(`/tmp/smear-pane-${tag}.txt`, cap);
			writeFileSync(`/tmp/smear-stream-${tag}.txt`, [...prevLines()].join("\n"));
			console.error(
				`capture ${captures}: FAIL contiguous=${contiguous} tailLag=${tailLag} (newest=${newest}, lastShown=${nums[nums.length - 1]})`,
			);
			console.error("   nums:", nums.join(","));
		}
	}
}
clearInterval(gen);
tmux(["pipe-pane", "-t", SESSION]);
tmux(["kill-session", "-t", SESSION]);
console.error(
	`RESULT: ${smeared} bad captures of ${checked} checked (${captures} total); recording: ${recording}`,
);
process.exit(smeared > 0 ? 1 : 0);

function prevLines(): string[] {
	try {
		return readFileSync(streamFile, "utf8")
			.split("\n")
			.filter((l) => l !== "");
	} catch {
		return [];
	}
}
