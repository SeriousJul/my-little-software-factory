/**
 * The observation report at the plane's seam (issue #422, ADR 0146).
 *
 * The operator's screen changes only when a fact the operator can read
 * changes. While the Agents work and nothing moves, the base screen stands
 * still for the whole turn: a quiet cycle of the observation reaches the
 * plane as the report object it already applied, the plane writes nothing,
 * and the renderer announces no frame on the poll's cadence. The standing
 * case that does move the screen is the probe's failure: the report moves
 * the roster to null, the plane writes the stale standing, and the marker
 * lands on the Message line. The fault records a message the run's history
 * holds, so the action bar earns the Message hint beside the line and the
 * bar's own packing gives one hint back to fit it; every fact row the
 * operator reads stands where it stood. When the probe succeeds again, the
 * marker clears and the screen stands on the Agents' true standing again.
 *
 * The frame stands at the harness's 120 columns: the longest line is the
 * failed probe's line on the Message line, under 80 display columns, so no
 * line the plane states is cut at the edge, and the row states the whole
 * statement. The poll loop runs at the named interval the harness hands the
 * App, so the steady-state cycles are paced by the test, not the wall
 * clock.
 */

import { describe, expect, test } from "bun:test";
import { CliRenderEvents } from "@opentui/core";

import {
	frameUntil,
	HEIGHT,
	messageRowOf,
	rowsOf,
	settle,
	sleep,
	WIDTH,
	withApp,
} from "./app-harness.ts";
import { DEFAULT_AGENT_NAME, issueTicket, ticketOf } from "./fact-fixtures.ts";
import { agentListJson } from "./fake-runner.ts";
import { issuesSourceConfig, type Plane, plane } from "./plane.ts";

/** The interval the plane's poll loop runs at: the test paces the cycles. */
const POLL_MS = 50;

/** The one Agent the list probe answers while it stands. */
const LISTING = {
	paneId: "pane-1",
	tabId: "tab-1",
	workspaceId: "ws-1",
	agent: DEFAULT_AGENT_NAME,
	status: "working",
};

/**
 * The key hints the base action bar can name, in the label the shared
 * catalogue gives each. The bar packs these by priority into its width:
 * when the fault line records a message it earns the Message hint, and the
 * shared bar drops the lowest-priority hint to fit it. Comparing the set the
 * bar names, not the row's spacing, is what keeps the assertion on the fact
 * (which hints the bar offers) and off the packing's geometry.
 */
const BAR_HINTS = [
	"Move",
	"Detail",
	"Live view",
	"Goto",
	"Close",
	"Ignore",
	"Section",
	"Override",
	"Refresh",
	"Message",
	"Help",
] as const;

/** The key hints one action bar row names, as the set the bar offers. */
function barHints(row: string): ReadonlySet<string> {
	return new Set(BAR_HINTS.filter((hint) => row.includes(hint)));
}

/** The hints the one row gained over the other, in catalogue order. */
function gainedHints(a: string, b: string): string[] {
	const aSet = barHints(a);
	return BAR_HINTS.filter((hint) => aSet.has(hint) && !barHints(b).has(hint));
}

/** The hints the one row lost against the other, in catalogue order. */
function lostHints(a: string, b: string): string[] {
	const bSet = barHints(b);
	return BAR_HINTS.filter((hint) => bSet.has(hint) && !barHints(a).has(hint));
}

/**
 * Assert that the frame stands on the base screen's rows, leaving to the
 * caller the rows it handles on its own: the fact rows the operator reads
 * must stand byte-identical, and only the rows the assertion names may move.
 */
function expectStandingRows(
	baseRows: readonly string[],
	frameRows: readonly string[],
	skips: readonly number[],
): void {
	for (let i = 0; i < baseRows.length; i += 1) {
		if (skips.includes(i)) continue;
		expect(frameRows[i]).toBe(baseRows[i]);
	}
}

/**
 * The plane the report's standing stands on: one in-flight ticket whose
 * Agent stands working in the probe's list, so the row answers the standing
 * the probe reports, and the cycle's walks move nothing. The Agent host
 * answers `herdr agent list` on the plane's own runner, and the test takes
 * the failure and the recovery by re-stubbing that one command.
 */
async function heldPlane(): Promise<{
	planeRecord: Plane;
	probeCalls: () => number;
	failProbe: () => void;
	recoverProbe: () => void;
}> {
	const held = ticketOf(issueTicket("github:github.com:I_5"), {
		state: "handed-off",
		handoff: {
			agentType: "pi",
			environment: "live-worktree",
			taskType: "implement",
			host: "herdr" as const,
			model: "",
			thinking: "",
			contextWindow: "",
			attemptId: "seeded-held",
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			herdrName: null,
			startedAt: "2026-01-01T00:00:00Z",
		},
		handoffCount: 1,
	});
	const planeRecord = await plane({
		agentHostEnv: { herdrEnv: "1" },
		groupingAxis: "none",
		sources: [{ config: issuesSourceConfig, tickets: [held] }],
		commands: (fake) => {
			fake.set("herdr", ["agent", "list"], { stdout: agentListJson([LISTING]) });
		},
	});
	const listProbe = (): number =>
		planeRecord.fakeRunner.calls.filter(
			(call) => call.command === "herdr" && call.args[0] === "agent" && call.args[1] === "list",
		).length;
	return {
		planeRecord,
		probeCalls: listProbe,
		failProbe: () => {
			planeRecord.fakeRunner.set("herdr", ["agent", "list"], {
				code: 1,
				stdout: "",
				stderr: "no herdr session",
			});
		},
		recoverProbe: () => {
			planeRecord.fakeRunner.set("herdr", ["agent", "list"], { stdout: agentListJson([LISTING]) });
		},
	};
}

describe("the observation report at the plane's seam (issue #422, ADR 0146)", () => {
	test("a quiet cycle lands no frame, and the screen stands byte-identical", async () => {
		const { planeRecord, probeCalls } = await heldPlane();
		await withApp(
			async (setup) => {
				let frames = 0;
				const countFrame = (): void => {
					frames += 1;
				};
				setup.renderer.on(CliRenderEvents.FRAME, countFrame);
				const base = await settle(setup);
				// A grace past the poll's interval: every one-shot paint the
				// boot owes lands before the window the assertion measures.
				await sleep(3 * POLL_MS);
				frames = 0;
				const before = probeCalls();
				const deadline = Date.now() + 5000;
				while (probeCalls() < before + 3) {
					if (Date.now() > deadline)
						throw new Error(`the poll ran ${probeCalls() - before} more cycles, not three`);
					await sleep(25);
				}
				setup.renderer.off(CliRenderEvents.FRAME, countFrame);
				// The quiet cycles owed the plane the report it already applied:
				// the plane wrote no state, the renderer announced no frame,
				// and the screen the operator reads stands where it stood.
				expect(frames).toBe(0);
				expect(setup.captureCharFrame()).toBe(base);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: POLL_MS },
			},
		);
	});

	test("a failed probe paints the failure marker with no other change to a fact row, and the recovery clears the marker", async () => {
		const { planeRecord, failProbe, recoverProbe } = await heldPlane();
		await withApp(
			async (setup) => {
				const base = await settle(setup);
				failProbe();
				const failed = await frameUntil(setup, "the failure marker on the Message line", (frame) =>
					messageRowOf(frame).includes(
						"herdr is unreachable: no herdr session; the observation is holding",
					),
				);
				const baseRows = rowsOf(base);
				const failedRows = rowsOf(failed);
				expect(failedRows).toHaveLength(baseRows.length);
				const line = failedRows.length - 2;
				const action = failedRows.length - 1;
				// The marker: the Message line moves from the boot statement to the
				// fault, and it is the one fact row the failed probe changes.
				expect(failedRows[line]).not.toBe(baseRows[line]);
				// Every fact row the operator reads stands where it stood: the
				// ticket row holds its last known standing, the counts move
				// nothing, and the screen is byte-identical below the line.
				expectStandingRows(baseRows, failedRows, [line, action]);
				// The one change beside the line: the fault line records a
				// message, so the bar earns the Message hint and the shared
				// packing drops the lowest-priority hint to fit it. The bar's
				// fact is which hints it offers, and the fault moves exactly
				// that: it gains the Message hint and gives the Ignore hint
				// back, nothing else.
				expect(gainedHints(failedRows[action], baseRows[action])).toEqual(["Message"]);
				expect(lostHints(failedRows[action], baseRows[action])).toEqual(["Ignore"]);
				recoverProbe();
				// The marker clears on the first probe that succeeds again: the
				// fault line ends, the roster returns, and the recovery lands in the
				// one frame that both clears the marker and restores the standing.
				const recovered = await frameUntil(
					setup,
					"the recovery clearing the failure marker",
					(frame) => !messageRowOf(frame).includes("herdr is unreachable"),
				);
				const recoveredRows = rowsOf(recovered);
				expect(recoveredRows).toHaveLength(baseRows.length);
				expect(messageRowOf(recovered)).not.toContain("herdr is unreachable");
				// The run's history still holds the facts it recorded, so the bar
				// keeps the Message hint the fault earned: the recovery restores the
				// standing and clears the marker, and the bar stands on the same
				// hints it held while the fault stood.
				expect(recoveredRows[action]).toBe(failedRows[action]);
				// The screen stands on the Agents' true standing again: every
				// fact row is back to where the base screen stood.
				expectStandingRows(baseRows, recoveredRows, [line, action]);
			},
			{
				width: WIDTH,
				height: HEIGHT,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: POLL_MS },
			},
		);
	});
});
