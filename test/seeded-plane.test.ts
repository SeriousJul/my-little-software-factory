/**
 * The Seeded plane's own suite.
 *
 * The plane is tested through its own interface: the standing a test asks
 * for is read back through the state module's own reads, so a wrong fixture
 * fails here instead of in the suites it serves. The checks name the standing
 * and the outcome they expect, and they read the outcome through the seam
 * the plane exists to stand beside: the state module's list rule, its
 * Consultation records, and its queue rows.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { loadConfigFile } from "../src/config.ts";
import { workQueueIdentityOf } from "../src/state/work-queue.ts";
import { FakeRunner } from "./fake-runner.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";
import { plane, type SeededPlane, type SeededPlaneStanding, withPlane } from "./seeded-plane.ts";

const ISSUES = { name: "issues", kind: "github-issues" };

/** The standing's rows, by identity, read through the state module's list rule. */
function viewsOf(p: SeededPlane) {
	return p.state.ticketWorkCycle.ticketListViews(
		p.config.workflowStates,
		p.config.defaultTaskType,
		"active",
	);
}

describe("the default standing", () => {
	test("the list the plane stands on is the state module's own rule over the sample rows", async () => {
		const p = await plane();
		const views = viewsOf(p);
		// The flat axis is the default, and the rule orders the sample rows:
		// the live bands first - awaiting, running, handed-off - and the open
		// pile by issue number.
		expect(views.rows.map((row) => row.identity)).toEqual([
			"github:github.com:I_4",
			"github:github.com:I_3",
			"github:github.com:I_2",
			"github:github.com:I_1",
			"github:github.com:I_5",
			"github:github.com:I_6",
			"github:github.com:I_7",
			"github:github.com:I_8",
		]);
		expect(views.active).toHaveLength(8);
		expect(views.ignored).toHaveLength(0);
		expect(views.muted).toHaveLength(0);
		p.close();
	});

	test("the live rows stand on their stored handoffs", async () => {
		const p = await plane();
		const views = viewsOf(p);
		const handedOff = views.rows.find((row) => row.identity === "github:github.com:I_2");
		expect(handedOff?.state).toBe("handed-off");
		expect(handedOff?.handoff?.agentType).toBe("codex");
		expect(handedOff?.handoff?.herdrName).toBe("sample-agent");
		expect(handedOff?.handoffCount).toBe(1);
		const running = views.rows.find((row) => row.identity === "github:github.com:I_3");
		expect(running?.state).toBe("running");
		expect(running?.handoffCount).toBe(2);
		expect(running?.workCycle).toBe(2);
		p.close();
	});

	test("the awaiting row stands on its settled turn, named by the handoff that settled it", async () => {
		const p = await plane();
		const views = viewsOf(p);
		const awaiting = views.rows.find((row) => row.identity === "github:github.com:I_4");
		expect(awaiting?.state).toBe("awaiting");
		expect(awaiting?.lastCompletion?.taskType).toBe("review");
		expect(awaiting?.lastCompletion?.cause).toBe("completed");
		// The turn's agent name stands on the herdr name the newest handoff
		// recorded: the plane's own naming fact, not a word the fixture made up.
		expect(awaiting?.lastCompletion?.agentName).toBe("sample-agent");
		p.close();
	});

	test("the config file on disk carries the plane's config", async () => {
		const p = await plane();
		expect(existsSync(p.configPath)).toBe(true);
		const loaded = await loadConfigFile(p.configPath);
		expect(loaded.config).toEqual(p.config);
		p.close();
	});
});

describe("the named standings", () => {
	test("an empty standing names no tickets and no sources", async () => {
		const p = await plane({ sources: [] });
		expect(p.sources).toHaveLength(0);
		expect(viewsOf(p).rows).toHaveLength(0);
		p.close();
	});

	test("a muted source stands in the muted view, and its resting rows leave the list", async () => {
		const p = await plane({ mutedSources: ["issues"] });
		const views = viewsOf(p);
		// The muted view is the ledger of the source act: every ticket of the
		// muted source, live and resting alike.
		expect(views.muted).toHaveLength(8);
		// The flag withholds only resting rows: the live work stays listed, and
		// the five resting tickets leave the drawn list.
		expect(views.active.map((ticket) => ticket.identity)).toEqual([
			"github:github.com:I_4",
			"github:github.com:I_3",
			"github:github.com:I_2",
		]);
		p.close();
	});

	test("an ignored ticket stands in the ignored view", async () => {
		const p = await plane({
			sources: [
				{
					config: {
						name: "issues",
						kind: "github-issues",
						refreshIntervalSeconds: 60,
						repositories: ["acme/billing"],
						host: "github.com",
					},
					tickets: [{ ...SAMPLE_TICKETS[0], ignored: true }],
				},
			],
		});
		const views = viewsOf(p);
		expect(views.rows).toHaveLength(0);
		expect(views.ignored).toHaveLength(1);
		p.close();
	});

	test("a resting row with a closed cycle rests past it", async () => {
		const resting = {
			...SAMPLE_TICKETS[4],
			handoff: SAMPLE_TICKETS[1].handoff,
			handoffCount: 1,
		};
		const p = await plane({
			sources: [
				{
					config: {
						name: "issues",
						kind: "github-issues",
						refreshIntervalSeconds: 60,
						repositories: ["acme/portal"],
						host: "github.com",
					},
					tickets: [resting],
				},
			],
		});
		const views = viewsOf(p);
		const row = views.rows[0];
		expect(row?.state).toBe("open");
		expect(row?.workCycle).toBe(2);
		expect(row?.handoffCount).toBe(1);
		p.close();
	});

	test("the named grouping axis is the axis the plane stands on", async () => {
		const p = await plane({ groupingAxis: "repository" });
		expect(p.state.grouping.groupingAxis("tickets")).toBe("repository");
		p.close();
	});

	test("the named clock is the clock the state writes from", async () => {
		const now = () => 1_000_000;
		const p = await plane({ now });
		expect(p.state.now()).toBe(1_000_000);
		p.close();
	});

	test("a Consultation standing stands in the record the plane's own read reports", async () => {
		const p = await plane({
			config: {
				consultationTypes: {
					grill: { agent: "pi", environment: "worktree", template: "/grill {input}" },
				},
			},
			consultations: [
				{
					id: "c-1",
					typeName: "grill",
					agentType: "pi",
					environment: "worktree",
					template: "/grill {input}",
					initialInput: "review auth",
					renderedOpeningPrompt: "/grill review auth",
					repository: {
						identity: "github.com/acme/factory",
						displayName: "acme/factory",
						cloneUrl: "https://github.com/acme/factory.git",
						path: "/checkout",
					},
					agentName: "consultation-c-1",
					agent: true,
					state: "working",
				},
			],
		});
		const record = p.state.consultationRecord.consultation("c-1");
		expect(record?.state).toBe("working");
		expect(record?.agentName).toBe("consultation-c-1");
		p.close();
	});

	test("a queue standing stands in the queue the plane's own read reports", async () => {
		const p = await plane({
			queue: [
				{
					kind: "handoff",
					ticketIdentity: "github:github.com:I_1",
					origin: "open",
					choice: {
						agentType: "pi",
						environment: "worktree",
						taskType: "implement",
						model: "",
						thinking: "",
						contextWindow: "",
					},
					previousMessage: "",
				},
			],
		});
		const items = p.state.workQueue.items();
		expect(items).toHaveLength(1);
		expect(workQueueIdentityOf(items[0])).toBe("github:github.com:I_1");
		p.close();
	});
});

describe("the plane's close", () => {
	test("the withPlane form closes the state before the body's end, however the body ends", async () => {
		const paths: string[] = [];
		const result = await withPlane({}, (p) => {
			paths.push(p.home);
			throw new Error("the body ends on its own");
		}).catch((error: Error) => error.message);
		expect(result).toBe("the body ends on its own");
		// The state closed before the directories went: the file is gone with
		// them, and a read of the closed database is refused.
		expect(existsSync(paths[0])).toBe(false);
	});

	test("a close the test runs on its own leaves nothing for the cleanup to do", async () => {
		const p = await plane({});
		p.close();
		expect(existsSync(p.home)).toBe(false);
		// The close is idempotent: the registry's pass over the same plane
		// changes nothing.
		expect(() => p.close()).not.toThrow();
	});

	test("the standing's commands run over the FakeRunner the plane hands out", async () => {
		const p = await plane({
			commands: (fake) =>
				fake.set("git", ["-C", "/checkout", "rev-parse", "--git-dir"], { stdout: ".git\n" }),
		});
		expect(p.fakeRunner).toBe(p.runner as FakeRunner);
		p.close();
	});
});
