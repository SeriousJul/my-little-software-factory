/**
 * Regression test: the renderer must converge after the host terminal loses
 * bytes from a frame.
 *
 * The native renderer diffs its screen model against what it believes the
 * terminal shows, and it marks a model cell as written while emitting the
 * frame's bytes. If the host terminal loses any of those bytes (a pty
 * reader that drops or coalesces a chunk), the model and the screen
 * diverge: every later frame diffs against the model, so the lost cells
 * are skipped forever and stale fragments of an earlier frame linger on
 * screen (upstream: anomalyco/opentui issue 1187).
 *
 * This test proves the control plane recovers from exactly that loss at the
 * real executable boundary. Two sessions run the same seeded state and the
 * same keys on 146x34 pseudo-terminals:
 *
 * - the clean session renders the ground truth;
 * - the lossy session has the middle of one decision-modal frame dropped
 *   at the pty master, after the app's own write already succeeded. That is
 *   the terminal-side loss the app cannot see.
 *
 * Both sessions then settle, and one small interaction (moving the action
 * selection) triggers a further diff frame. The final screens must match:
 * without per-frame full repaints the lossy session keeps the stale cells
 * of the dropped frame, and the grids differ.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { openFactoryState } from "../src/state.ts";
import type { TurnLogEntry } from "../src/turn-log.ts";
import { openControlPlanePty } from "./executable-pty.ts";
import { renderStream, splitFrames } from "./term-model.ts";

const COLS = 146;
const ROWS = 34;
const STARTUP_TIMEOUT_MS = 15_000;
const STABLE_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 90_000;

/** The decision modal's pop-in title, present only in modal frames. */
const MODAL_MARKER = Buffer.from("Decision:");
/** A settled-modal cell unique to the seeded completion trace. */
const TRACE_MARKER = "MERGEABLE, HEAD 546055f";
/** The action row the test moves, to trigger one diff after the drop. */
const CLOSE_ACTION = "Close";
/** ArrowDown: move the action selection one row. */
const ARROW_DOWN = "\x1b[B";
const ENTER_KEY = "\r";

describe("control plane executable, terminal frame loss", () => {
	let dir: string | undefined;

	afterAll(() => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	it(
		"repaints the screen after the terminal drops bytes from a frame",
		async () => {
			dir = mkdtempSync(join(tmpdir(), "factory-desync-"));
			const clean = await runSession(dir, "clean");
			const lossy = await runSession(dir, "lossy");

			// The decision modal must actually have rendered: the title, the
			// seeded completion trace, and the action row are all on screen.
			for (const [name, screen] of [
				["clean", clean.screen],
				["lossy", lossy.screen],
			] as const) {
				expect(screen.includes("Decision:"), `${name} modal title`).toBe(true);
				expect(screen.includes(TRACE_MARKER), `${name} completion trace`).toBe(true);
				expect(screen.includes(CLOSE_ACTION), `${name} action row`).toBe(true);
			}

			// The drop must target a real modal frame, not a stray.
			expect(lossy.droppedFrameBytes, "a decision-modal frame to drop").toBeGreaterThan(1000);

			// The lossy session's final screen must equal the clean one: the
			// dropped bytes are gone, so convergence requires a full repaint
			// in a later frame.
			expect(lossy.screen, screenDiff(clean.screen, lossy.screen)).toBe(clean.screen);
		},
		TEST_TIMEOUT_MS,
	);
});

interface SessionResult {
	/** The final screen text after settling. */
	screen: string;
	/** Bytes of the frame that was dropped, 0 when nothing was dropped. */
	droppedFrameBytes: number;
}

/**
 * Boot the control plane on a fresh 146x34 pty with one seeded awaiting
 * ticket, open the decision modal, settle, move the action selection once,
 * and settle again. Returns the final screen and the drop report.
 */
async function runSession(baseDir: string, kind: "clean" | "lossy"): Promise<SessionResult> {
	const dir = join(baseDir, kind);
	mkdirSync(dir, { recursive: true });
	const statePath = seedAwaitingTicket(join(dir, "state.sqlite"));
	const configPath = writeConfig(dir, statePath);
	const session = await openControlPlanePty(
		["--config", configPath],
		{
			HOME: dir,
			XDG_CONFIG_HOME: join(dir, ".config"),
			XDG_STATE_HOME: join(dir, ".state"),
			XDG_DATA_HOME: join(dir, ".data"),
			XDG_CACHE_HOME: join(dir, ".cache"),
			PATH: join(dir, "bin"),
		},
		{ size: { cols: COLS, rows: ROWS } },
	);
	if (session === null) {
		throw new Error("cannot open a pseudo-terminal on this platform");
	}
	try {
		await session.waitFor(
			(out) => out.includes("\x1b[?1049h"),
			"the alternate screen",
			STARTUP_TIMEOUT_MS,
		);
		await session.waitForStable(500, STABLE_TIMEOUT_MS);
		session.write(ENTER_KEY);
		await session.waitForStable(700, STABLE_TIMEOUT_MS);
		session.write(ARROW_DOWN);
		await session.waitForStable(700, STABLE_TIMEOUT_MS);
	} finally {
		session.dispose();
	}

	const stream = session.output();
	const { screen, droppedFrameBytes } =
		kind === "clean"
			? { screen: renderStream(stream), droppedFrameBytes: 0 }
			: dropOneModalFrame(stream);
	return { screen, droppedFrameBytes };
}

/**
 * Replay the stream with the middle of the largest decision-modal frame
 * dropped, as a terminal that lost that chunk of pty input would see it.
 *
 * The largest modal frame is the settled box: its content is the final
 * content, so every dropped cell would otherwise stay stale for the rest
 * of the session.
 */
function dropOneModalFrame(stream: Buffer): { screen: string; droppedFrameBytes: number } {
	const frames = splitFrames(stream);
	let target = -1;
	let best = 0;
	frames.forEach((frame, index) => {
		if (frame.includes(MODAL_MARKER) && frame.length > best) {
			best = frame.length;
			target = index;
		}
	});
	if (target === -1) return { screen: renderStream(stream), droppedFrameBytes: 0 };
	const frame = frames[target];
	const keepStart = Math.floor(frame.length * 0.25);
	const keepEnd = Math.floor(frame.length * 0.75);
	frames[target] = Buffer.concat([frame.subarray(0, keepStart), frame.subarray(keepEnd)]);
	return {
		screen: renderStream(Buffer.concat(frames)),
		droppedFrameBytes: keepEnd - keepStart,
	};
}

/** Seed the state DB with one awaiting ticket and a settled rework turn. */
function seedAwaitingTicket(statePath: string): string {
	const state = openFactoryState(statePath, () => Date.parse("2026-09-02T22:29:00Z"));
	const source = { name: "factory-pull-requests", kind: "github-pull-requests" as const };
	state.initializeSources([source]);
	const identity = "github.com/SeriousJul/my-little-software-factory/pull/14";
	state.applyFetch(source, {
		status: "success",
		fetchedAt: new Date(Date.parse("2026-09-02T22:20:00Z")).toISOString(),
		tickets: [
			{
				identity,
				sourceKind: "github-pull-requests",
				externalKey: "#14",
				sourceState: "open",
				url: "https://github.com/SeriousJul/my-little-software-factory/pull/14",
				title: "Add observation rework coverage for live-Consultation branches",
				description:
					"Extend the observation matrix so every live-Consultation branch is covered by a test.\n\nThe review flagged the refresh per-field branch and the unknown-status warning branch.",
				labels: ["needs-work", "factory", "observation"],
				externalUpdatedAt: new Date(Date.parse("2026-09-02T22:20:00Z")).toISOString(),
				repository: {
					identity: "github.com/seriousjul/my-little-software-factory",
					displayName: "my-little-software-factory",
					cloneUrl: "https://github.com/seriousjul/my-little-software-factory.git",
				},
				attributes: {},
			},
		],
	});
	const claim = state.claimHandoff(
		identity,
		{
			agentType: "pi",
			environment: "live-worktree",
			taskType: "rework",
			model: "",
			thinking: "",
			contextWindow: "",
		},
		"open",
	);
	if (!claim.ok) throw new Error(`claim failed: ${claim.reason}`);
	state.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-14",
		tabId: "tab-14",
		workspaceId: "ws-14",
	});
	const verification = [
		"Verification",
		"",
		"- npm test : 571 passed, 1 expected fail (#24), 27 files",
		"- git diff origin/main : 4 files, allatest/* + stryker.config.json - no production module touched",
		"- Stryker re-run on the pushed tip confirms the table's observation row",
		"- Hand mutations watched failing: both handoff-mode guide tests, the Consultations guide test, both empty-string guards, the grace boundary",
	].join("\n");
	const fillers: TurnLogEntry[] = [];
	for (let i = 1; i <= 12; i += 1) {
		fillers.push({
			kind: "tool",
			name: "bash",
			target: `npx vitest run test/consultation.test.ts -t 'branch ${i}'`,
			failed: false,
		});
		fillers.push({
			kind: "text",
			text: `Cycle ${i}: the branch test ${i} now exercises the handle refresh per-field path and the unknown-status warning path for live-Consultation observations.`,
		});
	}
	const conclusion =
		"PR: body rewritten, rework summary comment posted, needs-rework dropped, ready-for-review added, MERGEABLE, HEAD 546055f.";
	state.settleTurn({
		ticketIdentity: identity,
		handoffId: claim.claim.attemptId,
		taskType: "rework",
		agentType: "pi",
		message: conclusion,
		turnLog: [
			{ kind: "tool", name: "bash", target: "npm test", failed: false },
			...fillers,
			{
				kind: "text",
				text: "New on rework: Observation went 75.7% to 78.0% (652/836) - three live-Consultation branch tests (handle refresh per-field, unknown-status warning coverage.",
			},
			{ kind: "text", text: verification },
			{
				kind: "tool",
				name: "bash",
				target: "git push origin rework/observation-coverage",
				failed: false,
			},
			{ kind: "tool", name: "bash", target: "gh pr edit 14 --body <summary>", failed: false },
			{ kind: "text", text: conclusion },
		],
		completedAt: new Date(Date.parse("2026-09-02T22:28:30Z")).toISOString(),
	});
	state.close();
	return statePath;
}

/** Write the isolated config: no sources, a long agent poll, rework routing. */
function writeConfig(dir: string, statePath: string): string {
	const configPath = join(dir, "config.toml");
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFileSync(
		configPath,
		[
			'default-agent = "pi"',
			'default-environment = "live-worktree"',
			'default-task-type = "implement"',
			"auto-handoff = false",
			"max-parallel-agents = 2",
			"agent-poll-interval-seconds = 3600",
			"completion-message-lines = 200",
			"max-handoffs-per-ticket = 10",
			`state-file = "${statePath}"`,
			"workflows = []",
			"sources = []",
			"",
			"[agents.pi]",
			'kind = "pi"',
			"",
			"[task-types.implement]",
			'template = "Implement {title}"',
			"",
			"[task-types.rework]",
			'template = "Rework {title}"',
			"",
			"[[task-rules]]",
			'task-type = "rework"',
			"",
			"[task-rules.when]",
			'source-kind = "github-pull-requests"',
			'labels-any = [ "needs-work" ]',
			"",
		].join("\n"),
		"utf8",
	);
	return configPath;
}

/** Show the first differing lines of two screens in a failure message. */
function screenDiff(a: string, b: string): string {
	const aLines = a.split("\n");
	const bLines = b.split("\n");
	const rows = Math.max(aLines.length, bLines.length);
	const diffs: string[] = [];
	for (let row = 0; row < rows; row += 1) {
		const al = aLines[row] ?? "";
		const bl = bLines[row] ?? "";
		if (al !== bl) diffs.push(`  line ${row + 1}:\n    clean: ${al}\n    lossy: ${bl}`);
		if (diffs.length >= 8) break;
	}
	return `lossy screen did not converge to the clean screen;\ndiffering lines:\n${diffs.join("\n")}`;
}
