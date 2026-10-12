/**
 * The Seeded plane read through its own interface (issue #362, ADR 0131).
 *
 * A good test here names a standing and an outcome, and reads the answer
 * through the state module's own interface: the projection read answers the
 * state the standing names, the herdr Agent name the standing carries is the
 * name the naming rule derives, the Grouping axis is the axis the field
 * names, the clock is the clock the state reads, and the checkout on disk
 * answers the standing it stands in. The module's internals stay behind the
 * interface, so a standing the module builds wrong fails the reads.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { loadConfigFile } from "../src/config.ts";
import { workQueueIdentityOf } from "../src/state/work-queue.ts";
import {
	DEFAULT_IDENTITY,
	DEFAULT_REPOSITORY,
	fetchedTicket,
	handoffChoice,
	STABLE_NAME,
} from "./fact-fixtures.ts";

import { FakeRunner } from "./fake-runner.ts";
import { type Plane, plane, reopenState, withPlane } from "./plane.ts";
import { SAMPLE_TICKETS } from "./sample-tickets.ts";

const openPlanes: Plane[] = [];
afterEach(() => {
	for (const p of openPlanes.splice(0)) p.close();
});

/** Open a plane and hold it for the afterEach close. */
function hold(p: Plane): Plane {
	openPlanes.push(p);
	return p;
}

/** The standing's rows, by identity, read through the state module's list rule. */
function viewsOf(p: Plane) {
	return p.state.ticketWorkCycle.ticketListViews(
		p.config.workflowStates,
		p.config.defaultTaskType,
		"active",
	);
}

describe("the default standing", () => {
	test("the list the plane stands on is the state module's own rule over the sample rows", async () => {
		const p = hold(await plane());
		const views = viewsOf(p);
		// The flat axis is the default, and the rule orders the sample rows:
		// the live bands first - awaiting, running, handed-off - and the open
		// pile by issue number. The sample set lists no default Ticket, so the
		// plane's own standing is what the frame suites were written against.
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
	});

	test("the live rows stand on their stored handoffs", async () => {
		const p = hold(await plane());
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
	});

	test("the awaiting row stands on its settled turn, named by the handoff that settled it", async () => {
		const p = hold(await plane());
		const views = viewsOf(p);
		const awaiting = views.rows.find((row) => row.identity === "github:github.com:I_4");
		expect(awaiting?.state).toBe("awaiting");
		expect(awaiting?.lastCompletion?.taskType).toBe("review");
		expect(awaiting?.lastCompletion?.cause).toBe("completed");
		// The turn's agent name stands on the herdr name the newest handoff
		// recorded: the plane's own naming fact, not a word the fixture made up.
		expect(awaiting?.lastCompletion?.agentName).toBe("sample-agent");
	});

	test("the config file on disk carries the plane's config", async () => {
		const p = hold(await plane());
		expect(existsSync(p.configPath)).toBe(true);
		const loaded = await loadConfigFile(p.configPath);
		expect(loaded.config).toEqual(p.config);
	});

	test("the open standing lists the default Ticket open on the flat axis", async () => {
		await withPlane({ standing: "open" }, (p) => {
			expect(p.state.ticketWorkCycle.ticketState(DEFAULT_IDENTITY)).toBe("open");
			const views = viewsOf(p);
			expect(views.active.map((t) => t.identity)).toContain(DEFAULT_IDENTITY);
			expect(p.state.grouping.groupingAxis("tickets")).toBe("none");
		});
	});
});

describe("the seeded plane's standings", () => {
	test("the in-flight standing claims and settles the default Handoff", async () => {
		await withPlane({ standing: "in-flight" }, (p) => {
			expect(p.state.ticketWorkCycle.ticketState(DEFAULT_IDENTITY)).toBe("handed-off");
			const handles = p.state.handoff.handoffHandles(DEFAULT_IDENTITY);
			expect(handles.paneIds).toEqual(["pane-1"]);
			expect(handles.workspaceIds).toEqual(["ws-1"]);
		});
	});

	test("the awaiting standing settles the turn on the standing's own facts", async () => {
		await withPlane(
			{
				standing: "awaiting",
				turn: { message: "The walk is done.", cause: "failed" },
			},
			(p) => {
				expect(p.state.ticketWorkCycle.ticketState(DEFAULT_IDENTITY)).toBe("awaiting");
			},
		);
	});

	test("the closed-cycle standing closes the decision and re-verifies the Ticket", async () => {
		await withPlane({ standing: "closed-cycle" }, (p) => {
			// The re-verify after the close puts the Ticket back on the open
			// list, and a later open claim of it passes.
			expect(p.state.ticketWorkCycle.ticketState(DEFAULT_IDENTITY)).toBe("open");
			const claim = p.state.handoff.claimHandoff(DEFAULT_IDENTITY, handoffChoice(), "open");
			expect(claim.ok).toBe(true);
		});
	});

	test("the handoffs field stands a stored handoff beside the standing", async () => {
		await withPlane(
			{
				standing: "open",
				tickets: [fetchedTicket(), fetchedTicket({ identity: "github:github.com:I_6" })],
				handoffs: [
					{
						ticket: "github:github.com:I_6",
						handles: { paneId: "pane-2", tabId: "tab-2", workspaceId: "ws-2" },
					},
				],
			},
			(p) => {
				expect(p.state.ticketWorkCycle.ticketState(DEFAULT_IDENTITY)).toBe("open");
				expect(p.state.ticketWorkCycle.ticketState("github:github.com:I_6")).toBe("handed-off");
				const handles = p.state.handoff.handoffHandles("github:github.com:I_6");
				expect(handles.paneIds).toEqual(["pane-2"]);
				expect(handles.workspaceIds).toEqual(["ws-2"]);
			},
		);
	});

	test("the herdr Agent name the standing carries is the name the naming rule derives", async () => {
		await withPlane({ standing: "awaiting" }, (p) => {
			expect(p.state.ticketWorkCycle.agentNameForTicket(DEFAULT_IDENTITY)).toBe(STABLE_NAME);
		});
	});

	test("the tickets field lists what the default source lists", async () => {
		const second = fetchedTicket({
			identity: "github:github.com:I_6",
			sourceKind: "github-pull-request",
			externalKey: "pull-6",
			title: "A pull request on the default repository",
		});
		await withPlane({ tickets: [fetchedTicket(), second] }, (p) => {
			const views = viewsOf(p);
			const ids = views.active.map((t) => t.identity);
			expect(ids).toContain(DEFAULT_IDENTITY);
			expect(ids).toContain("github:github.com:I_6");
		});
	});
});

describe("the seeded plane's facts", () => {
	test("the clock the plane hands back is the clock the state reads, on the machine clock", async () => {
		await withPlane({}, (p) => {
			const before = Date.now();
			expect(p.state.now()).toBeGreaterThanOrEqual(before);
			p.clock.advance(5_000);
			const clockBefore = p.clock.now();
			const stateNow = p.state.now();
			expect(stateNow).toBeGreaterThanOrEqual(before + 5_000);
			// The state's read stands between the clock's reads: the same live
			// wall clock serves both, and it never goes back.
			expect(stateNow).toBeGreaterThanOrEqual(clockBefore);
			expect(stateNow).toBeLessThanOrEqual(p.clock.now());
		});
	});

	test("the named clock is the clock the state writes from", async () => {
		await withPlane({ now: () => 1_000_000 }, (p) => {
			expect(p.state.now()).toBe(1_000_000);
			p.clock.advance(5_000);
			expect(p.state.now()).toBe(1_005_000);
			expect(p.clock.now()).toBe(1_005_000);
		});
	});

	test("the grouping axis field names the axis the plane stands", async () => {
		const p = hold(await plane({ groupingAxis: "repository" }));
		expect(p.state.grouping.groupingAxis("tickets")).toBe("repository");
	});

	test("the factory state fields write the state file before the App mounts", async () => {
		await withPlane({ autoHandoffMode: true, queuePaused: true }, (p) => {
			expect(p.state.handoff.autoHandoffMode()).toBe(true);
			expect(p.state.workQueue.queuePaused()).toBe(true);
		});
	});

	test("the config field lands on the config the plane resolves", async () => {
		await withPlane({ config: { maxParallelAgents: 7 } }, (p) => {
			expect(p.config.maxParallelAgents).toBe(7);
			expect(p.props.config).toBe(p.config);
		});
	});

	test("the checkout standing stands the checkout on disk", async () => {
		const none = hold(await plane({ checkout: "none" }));
		expect(none.checkout).toBeNull();
		expect(Object.keys(none.config.repos)).toEqual([]);

		const bare = hold(await plane({}));
		// The plane's own mapping stands when the case names the checkout
		// standing; a case that names no standing maps nothing, the list the
		// frame suites read on.
		expect(Object.keys(bare.config.repos)).toEqual([]);

		const empty = hold(await plane({ checkout: "empty" }));
		const emptyPath = empty.checkout;
		if (emptyPath === null) throw new Error("the empty checkout is missing");
		expect(existsSync(emptyPath)).toBe(true);
		expect(empty.config.repos[DEFAULT_REPOSITORY.identity]).toBe(emptyPath);

		const healthy = hold(await plane({ checkout: "healthy" }));
		const healthyPath = healthy.checkout;
		if (healthyPath === null) throw new Error("the healthy checkout is missing");
		const gitDir = await healthy.runner.run("git", ["-C", healthyPath, "rev-parse", "--git-dir"]);
		expect(gitDir.stdout).toBe(".git\n");
		const origin = await healthy.runner.run("git", [
			"-C",
			healthyPath,
			"remote",
			"get-url",
			"origin",
		]);
		expect(origin.stdout).toBe(`${DEFAULT_REPOSITORY.cloneUrl}\n`);
	});

	test("the props boot the App from the plane's own parts", async () => {
		await withPlane({ standing: "in-flight" }, (p) => {
			expect(p.props.state).toBe(p.state);
			expect(p.props.runner).toBe(p.runner);
			expect(p.props.home).toBe(p.home);
			expect(p.props.configPath).toBe(p.configPath);
			expect(p.props.config).toBe(p.config);
			expect(p.props.sources).toBe(p.sources);
			expect(p.props.loopPolicy).toEqual({ kind: "held" });
		});
	});

	test("the poll interval stands the props loop at the named interval", async () => {
		await withPlane({ pollIntervalMs: 250 }, (p) => {
			expect(p.props.loopPolicy).toEqual({ kind: "polled", intervalMs: 250 });
		});
	});

	test("a case pins its own answers on the plane's runner", async () => {
		await withPlane(
			{
				commands: (runner) =>
					runner.set("git", ["-C", "/elsewhere", "rev-parse", "--git-dir"], {
						stdout: "the case's own\n",
					}),
			},
			async (p) => {
				const answer = await p.runner.run("git", ["-C", "/elsewhere", "rev-parse", "--git-dir"]);
				expect(answer.stdout).toBe("the case's own\n");
			},
		);
	});

	test("the extra sources field stands a source double the config does not list", async () => {
		await withPlane({ extraSources: [{ name: "pulls", kind: "github-pull-requests" }] }, (p) => {
			expect(p.sources.map((s) => s.name)).toEqual(["issues", "pulls"]);
			expect(p.state.sourceFact.sourceHealths().map((h) => h.name)).toEqual(["issues"]);
		});
	});

	test("a case hands its own runner to the plane and the plane serves it", async () => {
		const world = new FakeRunner();
		await withPlane({ runner: () => world }, (p) => {
			expect(p.runner).toBe(world);
			expect(p.props.runner).toBe(world);
			expect(p.fakeRunner).not.toBe(world);
		});
	});
});

describe("the named standings of the factory", () => {
	test("an empty standing names no tickets and no sources", async () => {
		const p = hold(await plane({ sources: [] }));
		expect(p.sources).toHaveLength(0);
		expect(viewsOf(p).rows).toHaveLength(0);
	});

	test("a muted source stands in the muted view, and its resting rows leave the list", async () => {
		const p = hold(await plane({ mutedSources: ["issues"] }));
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
	});

	test("an ignored ticket stands in the ignored view", async () => {
		const p = hold(
			await plane({
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
			}),
		);
		const views = viewsOf(p);
		expect(views.rows).toHaveLength(0);
		expect(views.ignored).toHaveLength(1);
	});

	test("a resting row with a closed cycle rests past it", async () => {
		const resting = {
			...SAMPLE_TICKETS[4],
			handoff: SAMPLE_TICKETS[1].handoff,
			handoffCount: 1,
		};
		const p = hold(
			await plane({
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
			}),
		);
		const views = viewsOf(p);
		const row = views.rows[0];
		expect(row?.state).toBe("open");
		expect(row?.workCycle).toBe(2);
		expect(row?.handoffCount).toBe(1);
	});

	test("a Consultation standing stands in the record the plane's own read reports", async () => {
		const p = hold(
			await plane({
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
			}),
		);
		const record = p.state.consultationRecord.consultation("c-1");
		expect(record?.state).toBe("working");
		expect(record?.agentName).toBe("consultation-c-1");
	});

	test("a queue standing stands in the queue the plane's own read reports", async () => {
		const p = hold(
			await plane({
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
			}),
		);
		const items = p.state.workQueue.items();
		expect(items).toHaveLength(1);
		expect(workQueueIdentityOf(items[0])).toBe("github:github.com:I_1");
	});

	test("the repository inits standing stands the init facts the plane reports", async () => {
		const p = hold(
			await plane({
				sources: [
					{
						config: {
							name: "issues",
							kind: "github-issues",
							refreshIntervalSeconds: 60,
							repositories: ["acme/factory"],
							host: "github.com",
						},
						tickets: [SAMPLE_TICKETS[0]],
					},
				],
				repositoryInits: {
					"github.com/acme/factory": "settings-hash-1",
				},
			}),
		);
		const init = p.state.repositoryInit.repositoryInitFact("github.com/acme/factory");
		expect(init?.settingsHash).toBe("settings-hash-1");
		expect(init?.pushedCommit).toBe("init-commit");
		expect(p.state.repositoryInit.repositoryInitFact("github.com/acme/billing")).toBeNull();
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

	test("the plane's state path reopens on the state module's own seam", async () => {
		await withPlane({ autoHandoffMode: true }, (p) => {
			p.state.close();
			const reopened = reopenState(p.state.path);
			expect(reopened.handoff.autoHandoffMode()).toBe(true);
			reopened.close();
		});
	});

	test("withPlane answers with the body's answer", async () => {
		const answer = await withPlane({ standing: "in-flight" }, (p) =>
			p.state.ticketWorkCycle.ticketState(DEFAULT_IDENTITY),
		);
		expect(answer).toBe("handed-off");
	});

	test("a plane the caller opens is closed by the caller, once", async () => {
		const p = await plane({ standing: "closed-cycle" });
		const home = p.home;
		p.close();
		p.close();
		expect(existsSync(home)).toBe(false);
	});

	test("the standing's commands run over the FakeRunner the plane hands out", async () => {
		const p = await plane({
			commands: (fake) =>
				fake.set("git", ["-C", "/checkout", "rev-parse", "--git-dir"], { stdout: ".git\n" }),
		});
		expect(p.runner).toBe(p.fakeRunner);
	});
});
