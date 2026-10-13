/**
 * The campaign's walk over the frame suites, committed so a reviewer re-
 * derives the before and after and a following migration step extends the
 * same numbers instead of re-walking.
 *
 * Usage: bun run scripts/walk-frame-rig-counts.ts [repoDir]
 *
 * The scope is the frame suites: the test files that import the shared frame
 * rig from `test/app-harness.ts`. The rig itself is out of scope: it is the
 * surface the walk measures against.
 *
 * Each count is this script's own definition, applied line by line, and the
 * numbers the verification record quotes for the campaign are this script's
 * output at the named heads:
 *
 * - `press-family`: a call to the rig's raw key press family, the six names
 *   `press`, `pressArrow`, `pressScrollKey`, `pressF1`, `pressF2`, and
 *   `pressCtrlC`.
 * - `hand-ops`: a call to a retired hand operation the architecture check's
 *   retired list polices on the owned surfaces: the hand open or close of a
 *   panel or guide, the hand focus move, and the hand scroll or cross.
 * - `raw-waits`: a call to `awaitFrame` or `awaitFrameChecking`, the raw wait
 *   the rig's `pressControl` and `waitFor` replace.
 * - `handler-probes`: a call to a key handler probe the rig's key ownership
 *   window replaces: `keyHandlerListeners`, `awaitNewKeyHandler`,
 *   `awaitGoneKeyHandler`, `baseKeyHandlers`, `awaitBaseKeyHandlers`.
 * - `inline-containment`: a line that carries both an arrow and a direct
 *   containment check on a frame string, the coarse line proxy for an inline
 *   frame predicate the closed set of outcomes replaces. A predicate that
 *   routes the frame through a named helper is not counted: the helper keeps
 *   the wording beside the rig.
 * - `renderer-reaches`: a reach to the renderer's raw feeders as a property,
 *   `setup.mockInput` and `setup.mockMouse`.
 * - `helper-copies`: a function a frame suite declares under a retired stem,
 *   the per-suite copy of a press, open, close, wait, hold, scroll, focus,
 *   cross, type, or settle the rig should own.
 * - `rig-exports`: the rig's own export lines in `test/app-harness.ts`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoDir = process.argv[2] ?? process.cwd();
const testDir = join(repoDir, "test");

const PRESS_FAMILY = ["press", "pressArrow", "pressScrollKey", "pressF1", "pressF2", "pressCtrlC"];

const HAND_OPS = [
	"openPanel",
	"openGuide",
	"openMessageView",
	"openLauncher",
	"closeOverlay",
	"openSurface",
	"openConsultationPanel",
	"confirmPanel",
	"focusDetail",
	"focusList",
	"scrollDetailUntil",
	"crossToConsultations",
	"crossToTickets",
];

const RAW_WAIT_NAMES = ["awaitFrame", "awaitFrameChecking"];

const HANDLER_PROBE_NAMES = [
	"keyHandlerListeners",
	"awaitNewKeyHandler",
	"awaitGoneKeyHandler",
	"baseKeyHandlers",
	"awaitBaseKeyHandlers",
];

const HELPER_STEMS = [
	"press",
	"open",
	"close",
	"wait",
	"hold",
	"scroll",
	"focus",
	"cross",
	"type",
	"settle",
];

const calls = (names: readonly string[]) =>
	names.map((name) => new RegExp(`\\b${name}\\s*\\(`, "u"));
const pressPatterns = calls(PRESS_FAMILY);
const handOpPatterns = calls(HAND_OPS);
const waitPatterns = calls(RAW_WAIT_NAMES);
const probePatterns = calls(HANDLER_PROBE_NAMES);
const reachPattern = /\.[m]ock(Input|Mouse)\b/u;
const containmentPattern = /\b(f|frame|line|text|row|rows)\.includes\(/;
const helperPattern = new RegExp(
	`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+(?:${HELPER_STEMS.join("|")})[A-Za-z0-9_]*\\s*\\(`,
	"u",
);

/** The frame suites: the test files that import the shared frame rig. */
const frameSuites = readdirSync(testDir)
	.filter((file) => file.endsWith(".test.ts"))
	.map((file) => join(testDir, file))
	.filter((file) => readFileSync(file, "utf8").includes(`from "./app-harness.ts"`));

const METRICS = [
	"press-family",
	"hand-ops",
	"raw-waits",
	"handler-probes",
	"inline-containment",
	"renderer-reaches",
	"helper-copies",
] as const;
type Metric = (typeof METRICS)[number];

const totals: Record<Metric, number> = {
	"press-family": 0,
	"hand-ops": 0,
	"raw-waits": 0,
	"handler-probes": 0,
	"inline-containment": 0,
	"renderer-reaches": 0,
	"helper-copies": 0,
};

console.log(`frame suites: ${frameSuites.length} (the test files that import the rig)`);
console.log("");
console.log(METRICS.map((metric) => metric).join("\t"));
for (const file of frameSuites) {
	const lines = readFileSync(file, "utf8").split("\n");
	const counts: Record<Metric, number> = {
		"press-family": 0,
		"hand-ops": 0,
		"raw-waits": 0,
		"handler-probes": 0,
		"inline-containment": 0,
		"renderer-reaches": 0,
		"helper-copies": 0,
	};
	for (const line of lines) {
		if (pressPatterns.some((pattern) => pattern.test(line))) counts["press-family"] += 1;
		if (handOpPatterns.some((pattern) => pattern.test(line))) counts["hand-ops"] += 1;
		if (waitPatterns.some((pattern) => pattern.test(line))) counts["raw-waits"] += 1;
		if (probePatterns.some((pattern) => pattern.test(line))) counts["handler-probes"] += 1;
		if (line.includes("=>") && containmentPattern.test(line)) counts["inline-containment"] += 1;
		if (reachPattern.test(line)) counts["renderer-reaches"] += 1;
		if (helperPattern.test(line)) counts["helper-copies"] += 1;
	}
	for (const metric of METRICS) totals[metric] += counts[metric];
	console.log(
		[file.slice(testDir.length + 1), ...METRICS.map((metric) => counts[metric])].join("\t"),
	);
}

const rigSource = readFileSync(join(testDir, "app-harness.ts"), "utf8");
const rigExports = rigSource.split("\n").filter((line) => line.startsWith("export ")).length;

console.log("");
console.log("totals over the frame suites:");
for (const metric of METRICS) console.log(`  ${metric}\t${totals[metric]}`);
console.log(`  rig-exports\t${rigExports} (the rig's own export lines in test/app-harness.ts)`);
