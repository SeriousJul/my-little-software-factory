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

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFile } from "../src/config.ts";
import { branchNameFor } from "../src/naming.ts";
import { workQueueIdentityOf } from "../src/state/work-queue.ts";
import { openFactoryState } from "../src/state.ts";
import {
	DEFAULT_IDENTITY,
	DEFAULT_REPOSITORY,
	fetchedTicket,
	handoffChoice,
	SAMPLE_TICKETS,
	STABLE_NAME,
} from "./fact-fixtures.ts";

import { FakeRunner } from "./fake-runner.ts";
import type { FakeSource } from "./fake-source.ts";
import { type Plane, plane, reopenState, withPlane } from "./plane.ts";

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
		const p = await plane();
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
	});

	test("the config file on disk carries the plane's config", async () => {
		const p = await plane();
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

	test("the plane settles the flat axis on every fresh file it opens", async () => {
		const bare = await plane();
		expect(bare.state.grouping.groupingAxis("tickets")).toBe("none");
		// The rule keys on the file the plane opens, not on the sources the
		// standing names: a standing that names no source settles the flat
		// axis on its fresh file the same way.
		const noSources = await plane({ sources: [] });
		expect(noSources.state.grouping.groupingAxis("tickets")).toBe("none");
	});
});

describe("the seeded plane's standings", () => {
	test("the in-flight standing claims and settles the default Handoff", async () => {
		await withPlane({ standing: "in-flight" }, (p) => {
			expect(p.state.ticketWorkCycle.ticketState(DEFAULT_IDENTITY)).toBe("handed-off");
			const handles = p.state.handoff.handoffHandles(DEFAULT_IDENTITY);
			expect(handles.paneIds).toEqual(["pane-1"]);
			expect(handles.workspaceIds).toEqual(["ws-1"]);
			// The row the standing writes is the default Ticket on its own key:
			// the branch the naming rule reads off that row is the key's number
			// and the shared title, so a standing that writes the Ticket on
			// another key would stand a branch no reader of the naming rule
			// would build.
			const row = viewsOf(p).active.find((t) => t.identity === DEFAULT_IDENTITY);
			expect(row?.externalKey).toBe("#9");
			if (!row) throw new Error("the standing's row is missing");
			expect(branchNameFor(row)).toBe("factory/9-persist-source-facts");
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

	test("the handoff field settles the standing's claim on the facts the case names", async () => {
		await withPlane(
			{
				standing: "in-flight",
				handoff: {
					environment: "live-worktree",
					handles: { paneId: "pane-9", tabId: "tab-9", workspaceId: "ws-9" },
				},
			},
			(p) => {
				expect(p.state.ticketWorkCycle.ticketState(DEFAULT_IDENTITY)).toBe("handed-off");
				const handles = p.state.handoff.handoffHandles(DEFAULT_IDENTITY);
				expect(handles.paneIds).toEqual(["pane-9"]);
				expect(handles.workspaceIds).toEqual(["ws-9"]);
				// The claim stands on the case's environment, over the choice the
				// suite shares.
				const handoff = p.state.handoff.latestHandoff(DEFAULT_IDENTITY);
				expect(handoff?.environment).toBe("live-worktree");
			},
		);
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
		const p = await plane({ groupingAxis: "repository" });
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
		const none = await plane({ checkout: "none" });
		expect(none.checkout).toBeNull();
		expect(Object.keys(none.config.repos)).toEqual([]);

		const bare = await plane({});
		// The plane's own mapping stands when the case names the checkout
		// standing; a case that names no standing maps nothing, the list the
		// frame suites read on.
		expect(Object.keys(bare.config.repos)).toEqual([]);

		const empty = await plane({ checkout: "empty" });
		const emptyPath = empty.checkout;
		if (emptyPath === null) throw new Error("the empty checkout is missing");
		expect(existsSync(emptyPath)).toBe(true);
		expect(empty.config.repos[DEFAULT_REPOSITORY.identity]).toBe(emptyPath);

		const healthy = await plane({ checkout: "healthy" });
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

	test("the repos field maps the named repositories under the plane's home", async () => {
		await withPlane({ repos: { "github.com/acme/billing": "src/acme/billing" } }, (p) => {
			expect(p.config.repos["github.com/acme/billing"]).toBe(join(p.home, "src/acme/billing"));
			expect(existsSync(join(p.home, "src/acme/billing"))).toBe(true);
		});
	});

	test("the home field stands the plane's paths in the case's own directory", async () => {
		const home = mkdtempSync(join(tmpdir(), "factory-plane-home-"));
		try {
			await withPlane({ home }, (p) => {
				expect(p.home).toBe(home);
				expect(existsSync(join(home, "state.sqlite"))).toBe(true);
				expect(existsSync(join(home, "config.toml"))).toBe(true);
			});
			// The plane clears the directories it makes, the home the case names aside.
			expect(existsSync(home)).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("the statePath field opens the state file at the path the case names", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-plane-state-path-"));
		const path = join(dir, "state.sqlite");
		const p = await plane({ statePath: path });
		try {
			expect(p.state.path).toBe(path);
			// The plane opens the file: its fresh-file rule settles the flat
			// axis on it, over the split the state module's own rule seeds.
			expect(p.state.grouping.groupingAxis("tickets")).toBe("none");
		} finally {
			p.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the prepare field stands the home's own facts before the standing names itself", async () => {
		await withPlane(
			{
				prepare: async (home) => {
					writeFileSync(join(home, "marker"), "the case stood the home");
					return { config: { maxParallelAgents: 9 } };
				},
			},
			(p) => {
				expect(existsSync(join(p.home, "marker"))).toBe(true);
				// The prepared facts stand beside the standing's own fields, over
				// them where they name one.
				expect(p.config.maxParallelAgents).toBe(9);
			},
		);
	});

	test("the existing field stands the plane on the state file the case opened", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-plane-existing-"));
		const state = openFactoryState(join(dir, "state.sqlite"));
		state.grouping.setGroupingAxis("tickets", "position");
		const p = await plane({ existing: state });
		try {
			expect(p.state).toBe(state);
			// The standing names no axis: the state's own axis stands, and the
			// plane writes nothing on a file it did not open.
			expect(p.state.grouping.groupingAxis("tickets")).toBe("position");
		} finally {
			p.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the standing names the axis the plane writes on a wrapped state", async () => {
		const dir = mkdtempSync(join(tmpdir(), "factory-plane-wrapped-axis-"));
		const state = openFactoryState(join(dir, "state.sqlite"));
		const p = await plane({ existing: state, groupingAxis: "none" });
		try {
			expect(p.state.grouping.groupingAxis("tickets")).toBe("none");
		} finally {
			p.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("held settled reads stand the sources' facts without the standing's rows", async () => {
		await withPlane({ settledReads: false }, (p) => {
			// The source stands its health in the state file; the settled read
			// the state writes is the test's to make, through the plane's own
			// doubles.
			expect(p.state.sourceFact.sourceHealths().map((h) => h.name)).toEqual(["issues"]);
			expect(viewsOf(p).rows).toHaveLength(0);
		});
	});

	test("the auto settlement stamps a settled read from the plane's clock", async () => {
		const manual = await plane({ now: () => 1_000_000 });
		const auto = await plane({ now: () => 1_000_000, sourceSettlement: "auto" });
		for (const [p, stamp] of [
			[manual, "2026-01-01T00:01:00Z"],
			[auto, new Date(1_005_000).toISOString()],
		] as const) {
			const source = p.sources[0] as FakeSource;
			const read = source.fetch();
			p.clock.advance(5_000);
			source.settleCurrent();
			const settled = await read;
			if (settled.status !== "success") throw new Error("the settled read failed");
			// The manual double settles on the outcome it holds, as given; the
			// auto double settles the same outcome stamped from the plane's
			// clock at the settle.
			expect(settled.fetchedAt).toBe(stamp);
		}
	});

	test("a named list stands in the state in place of the standing's rows", async () => {
		const named = fetchedTicket({
			identity: "github:github.com:I_6",
			sourceKind: "github-pull-request",
			externalKey: "pull-6",
			title: "A pull request on the default repository",
		});
		await withPlane(
			{
				tickets: [fetchedTicket()],
				sourceTickets: { issues: [named] },
			},
			async (p) => {
				// The named list stands on the settled read, in place of the
				// standing's rows.
				expect(viewsOf(p).rows.map((row) => row.identity)).toEqual(["github:github.com:I_6"]);
				// The plane's own double settles the same named list.
				const source = p.sources[0] as FakeSource;
				const read = source.fetch();
				source.settleCurrent();
				const settled = await read;
				if (settled.status !== "success") throw new Error("the settled read failed");
				expect(settled.tickets.map((ticket) => ticket.identity)).toEqual(["github:github.com:I_6"]);
			},
		);
	});

	test("a null entry stands the source initialized without a settled read", async () => {
		await withPlane({ tickets: [fetchedTicket()], sourceTickets: { issues: null } }, async (p) => {
			// The source stands its health without the settled read: no ticket
			// row stands on a read the state never took.
			expect(p.state.sourceFact.sourceHealths()).toHaveLength(1);
			expect(viewsOf(p).rows).toHaveLength(0);
			// The plane's own double holds the empty list it is never asked for.
			const source = p.sources[0] as FakeSource;
			const read = source.fetch();
			source.settleCurrent();
			const settled = await read;
			if (settled.status !== "success") throw new Error("the settled read failed");
			expect(settled.tickets).toHaveLength(0);
		});
	});
});

describe("the named standings of the factory", () => {
	test("an empty standing names no tickets and no sources", async () => {
		const p = await plane({ sources: [] });
		expect(p.sources).toHaveLength(0);
		expect(viewsOf(p).rows).toHaveLength(0);
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
	});

	test("an ignored ticket stands in the ignored view", async () => {
		const p = 
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
			});
		const views = viewsOf(p);
		expect(views.rows).toHaveLength(0);
		expect(views.ignored).toHaveLength(1);
	});

	test("the ignoredTickets field stands the named tickets in the ignored view", async () => {
		const p = await plane({ ignoredTickets: ["github:github.com:I_1"] });
		const views = viewsOf(p);
		expect(views.ignored).toHaveLength(1);
		expect(views.active.map((ticket) => ticket.identity)).not.toContain("github:github.com:I_1");
	});

	test("a resting row with a closed cycle rests past it", async () => {
		const resting = {
			...SAMPLE_TICKETS[4],
			handoff: SAMPLE_TICKETS[1].handoff,
			handoffCount: 1,
		};
		const p = 
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
			});
		const views = viewsOf(p);
		const row = views.rows[0];
		expect(row?.state).toBe("open");
		expect(row?.workCycle).toBe(2);
		expect(row?.handoffCount).toBe(1);
	});

	test("a Consultation standing stands in the record the plane's own read reports", async () => {
		const p = 
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
			});
		const record = p.state.consultationRecord.consultation("c-1");
		expect(record?.state).toBe("working");
		expect(record?.agentName).toBe("consultation-c-1");
	});

	test("a queue standing stands in the queue the plane's own read reports", async () => {
		const p = 
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
			});
		const items = p.state.workQueue.items();
		expect(items).toHaveLength(1);
		expect(workQueueIdentityOf(items[0])).toBe("github:github.com:I_1");
	});

	test("the repository inits standing stands the init facts the plane reports", async () => {
		const p = 
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
			});
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
