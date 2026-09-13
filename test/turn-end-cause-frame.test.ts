/**
 * The held turn through the real app flow: the production state, the
 * production turn-end reader on a real session file on disk, and the frame
 * the operator sees when a pi turn fails on its own text (test decision
 * #56; the application-flow reproduction the review asked for, issue #54).
 *
 * One seeded in-flight ticket, three open tickets, auto mode on, three
 * agent slots. The factory auto-hands off two of the open tickets while a
 * slot is free; the third waits on the limit. Then the seeded agent goes
 * idle and its record says the turn failed: the ticket rests in awaiting,
 * held, the dispatch pause arms, and the factory does not restart the
 * missing ticket, does not hand off the open one, and does not clean the
 * held ticket up. The frame shows the held badge, the `held: 1` attention
 * line, the `paused` mode line, the warning in the detail pane above the
 * last-completion line, and the turn's cause in the decision modal above
 * its action rows.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { FactoryConfig } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	detailPaneText,
	focusDetail,
	focusList,
	frameText,
	press,
	pressEnterQuiet,
	rowsOf,
	sleep,
	withApp,
} from "./app-harness.ts";
import { agentListJson, FakeRunner, tabCreateJson, workspaceListJson } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const source = { name: "issues", kind: "github-issues" };
const identityA = "github:github.com:I_5";
const identityB = "github:github.com:I_6";
const identityC = "github:github.com:I_7";
const identityD = "github:github.com:I_8";
const repoIdentity = "github.com/acme/live";
const QUOTA = "Your token-plan 1-week quota has been exhausted";

function fetched(index: number, title: string): FetchedTicket {
	return {
		identity: `github:github.com:I_${index}`,
		sourceKind: "github-issue",
		externalKey: `#${index}`,
		sourceState: "open",
		url: `https://github.com/acme/live/issues/${index}`,
		title,
		description: "Keep state independent from GitHub.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: repoIdentity,
			displayName: "acme/live",
			cloneUrl: `https://${repoIdentity}.git`,
		},
		attributes: {},
	};
}

/**
 * A state with the first ticket in flight and the other three open:
 * claimed, settled to the stored herdr handles, and resting in handed-off.
 */
function seededState(): FactoryState {
	const dir = mkdtempSync(join(tmpdir(), "factory-hold-state-"));
	paths.push(dir);
	const state = openFactoryState(join(dir, "state.sqlite"));
	state.initializeSources([source]);
	const success: FetchOutcome = {
		status: "success",
		fetchedAt: "2026-08-31T10:01:00Z",
		tickets: [
			fetched(5, "Persist source facts"),
			fetched(6, "Second open ticket"),
			fetched(7, "Third open ticket"),
			fetched(8, "Fourth open ticket"),
		],
	};
	state.applyFetch(source, success);
	const claim = state.claimHandoff(
		identityA,
		{
			agentType: "pi",
			environment: "live-worktree",
			taskType: "implement",
			model: "",
			thinking: "",
			contextWindow: "",
		},
		"open",
	);
	if (!claim.ok) throw new Error(claim.reason);
	state.settleHandoff(claim.claim.attemptId, true, undefined, {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
	return state;
}

describe("the held turn through the real app flow", () => {
	test("a failed pi turn holds, arms the pause, and shows the held surfaces", async () => {
		const runner = new FakeRunner();
		const dir = mkdtempSync(join(tmpdir(), "factory-hold-"));
		paths.push(dir);
		const checkoutPath = join(dir, "checkout");
		mkdirSync(checkoutPath);
		const recordPath = join(dir, "session.jsonl");
		const state = seededState();
		// The session file the production reader reads from disk: one
		// assistant message that failed on the provider's own text, with a
		// turn log of its own so the fallback never runs. The timestamp is
		// now, so it stands after the handoff's start time.
		writeFileSync(
			recordPath,
			`${JSON.stringify({
				type: "message",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "The retry lands only after the quota is raised." }],
					stopReason: "error",
					errorMessage: QUOTA,
				},
			})}\n`,
			"utf8",
		);
		const config: FactoryConfig = {
			...DEFAULT_CONFIG,
			repos: { [repoIdentity]: checkoutPath },
			workflows: [{ from: "implement", to: ["review"] }],
			autoHandoff: true,
			maxParallelAgents: 3,
		};
		const src = new FakeSource("issues", "github-issues", {
			status: "success",
			fetchedAt: "2026-08-31T10:01:00Z",
			tickets: [
				fetched(5, "Persist source facts"),
				fetched(6, "Second open ticket"),
				fetched(7, "Third open ticket"),
				fetched(8, "Fourth open ticket"),
			],
		});
		// The checkout's git answers and the herdr workspaces the
		// auto-handoffs dispatch into.
		runner.set("git", ["-C", checkoutPath, "rev-parse", "--git-dir"], { stdout: ".git\n" });
		runner.set("git", ["-C", checkoutPath, "remote", "get-url", "origin"], {
			stdout: `https://${repoIdentity}.git\n`,
		});
		runner.set("herdr", ["workspace", "list"], {
			stdout: workspaceListJson([{ id: "ws-live", checkoutPath, focused: true }]),
		});
		// Two tabs for the two auto-handoffs, one per ticket, in dispatch
		// order; both panes are listed as working below.
		runner.setSequence(
			"herdr",
			["tab", "create", "--workspace", "ws-live", "--cwd", checkoutPath, "--no-focus"],
			[{ stdout: tabCreateJson("pane-b", "tab-b") }, { stdout: tabCreateJson("pane-c", "tab-c") }],
		);
		// The seeded agent works, with the record as its session, and the
		// two panes the auto-handoffs land in.
		runner.set("herdr", ["agent", "list"], {
			stdout: agentListJson([
				{
					paneId: "pane-1",
					tabId: "tab-1",
					workspaceId: "ws-1",
					agent: "first-ticket",
					status: "working",
					sessionId: recordPath,
				},
				{
					paneId: "pane-b",
					tabId: "tab-b",
					workspaceId: "ws-live",
					agent: "second-ticket",
					status: "working",
				},
				{
					paneId: "pane-c",
					tabId: "tab-c",
					workspaceId: "ws-live",
					agent: "third-ticket",
					status: "working",
				},
			]),
		});

		await withApp(
			async (setup) => {
				src.settle({
					status: "success",
					fetchedAt: "2026-08-31T10:02:00Z",
					tickets: [
						fetched(5, "Persist source facts"),
						fetched(6, "Second open ticket"),
						fetched(7, "Third open ticket"),
						fetched(8, "Fourth open ticket"),
					],
				});
				// The auto-handoffs settle: two of the three open tickets
				// are running; the third waits on the agent limit.
				await waitUntil("the auto-handoffs to be running", () =>
					[identityB, identityC].every((identity) => state.ticketState(identity) === "running"),
				);
				// Let the stable cycles settle, then count the dispatch
				// commands: after the turn is held, nothing new may start an
				// agent. The observation loop's own agent list probes keep
				// running, so the total command count is the wrong measure.
				await sleep(100);
				const dispatchCount = () =>
					runner.commands().filter((command) => command.includes("agent start")).length;
				const before = dispatchCount();
				// The seeded agent goes idle: its record says the turn
				// failed on the provider's own text. The missing ticket's
				// agent drops out of the list at the same moment, so the
				// pause has a restart to refuse while it is armed.
				runner.set("herdr", ["agent", "list"], {
					stdout: agentListJson([
						{
							paneId: "pane-1",
							tabId: "tab-1",
							workspaceId: "ws-1",
							agent: "first-ticket",
							status: "idle",
							sessionId: recordPath,
						},
						{
							paneId: "pane-c",
							tabId: "tab-c",
							workspaceId: "ws-live",
							agent: "third-ticket",
							status: "working",
						},
					]),
				});
				await waitUntil(
					"the held ticket to rest in awaiting",
					() => state.ticketState(identityA) === "awaiting",
				);
				// Give the paused factory several full cycles to do nothing.
				await sleep(300);

				// The turn rests in awaiting, held, with the provider's own
				// text as its detail and no decision on it.
				const completion = state.lastCompletion(identityA);
				expect(completion?.cause).toBe("failed");
				expect(completion?.detail).toBe(QUOTA);
				expect(completion?.decision).toBeNull();
				// The dispatch pause is armed, and it holds: no restart of
				// the missing ticket, no handoff of the open one, no cleanup
				// of the held one.
				expect(state.dispatchPauseActive()).toBe(true);
				expect(dispatchCount()).toBe(before);
				for (const part of ["workspace close", "worktree remove", "tab close", "branch -D"]) {
					expect(runner.commands().some((command) => command.includes(part))).toBe(false);
				}
				// The missing ticket is not abandoned and the open one is
				// still open.
				expect(state.ticketState(identityB)).toBe("running");
				expect(state.ticketState(identityD)).toBe("open");

				// The frame: the mode line says paused, the row shows the
				// held badge in place of the state badge, the attention line
				// counts the held turn, and the message line names it.
				const frame = setup.captureCharFrame();
				const rows = rowsOf(frame);
				expect(rows[0]).toContain("auto: on 1/3 paused");
				const rowA = rows.find((row) => row.includes("Persist source facts"));
				expect(rowA).toBeDefined();
				expect(rowA).toContain("held");
				expect(rowA).not.toContain("[awaiting]");
				const text = frameText(frame);
				expect(text).toContain("held: 1");
				expect(text).toContain(
					"Warning: Dispatch pause: a held failed turn is blocking automatic dispatch",
				);

				// The detail pane: the warning stands above the
				// last-completion line and says what the control plane
				// refuses to do.
				await focusDetail(setup);
				const detail = detailPaneText(setup.captureCharFrame());
				const causeAt = detail.indexOf(`Turn ended failed: ${QUOTA}`);
				const refuseAt = detail.indexOf("no automatic decision runs on this turn");
				const completionAt = detail.indexOf("Last completion:");
				expect(causeAt).toBeGreaterThanOrEqual(0);
				expect(refuseAt).toBeGreaterThanOrEqual(0);
				expect(completionAt).toBeGreaterThan(causeAt);
				expect(completionAt).toBeGreaterThan(refuseAt);

				// The decision modal: the turn's cause stands in the body,
				// above the action rows the operator picks from. In auto
				// mode the factory decides a settled turn, so the operator
				// turns auto-handoff off first: the held turn then answers
				// to the operator's own Decide.
				await focusList(setup);
				await press(setup, "a", "auto-handoff to turn off", (f) => f.includes("auto: off"));
				const modal = await pressEnterQuiet(setup, "the decision modal", (f) =>
					f.includes("Decision:"),
				);
				const modalRows = rowsOf(modal);
				const holdAt = modalRows.findIndex((row) => row.includes("Turn ended failed"));
				const closeAt = modalRows.findIndex((row) => row.includes("Close"));
				expect(holdAt).toBeGreaterThanOrEqual(0);
				expect(closeAt).toBeGreaterThan(holdAt);
				await press(
					setup,
					"escape",
					"the decision modal to close",
					(f) => !f.includes("Decision:"),
				);
			},
			undefined,
			undefined,
			{ config, state, runner, sources: [src], pollIntervalMs: 20 },
		);
	});
});

async function waitUntil(label: string, check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(20);
	}
}
