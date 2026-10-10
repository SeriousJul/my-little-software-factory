/**
 * The Stub herdr world (ADR 0132): the suite for the deep adapter of the
 * herdr and git side of the Command runner seam.
 *
 * Every answer shape the world produces is tested against the plane's own
 * reader: the JSON it parses, the code it reads, and the refusal envelope the
 * handoff's `herdrErrorCode` takes. The closed-surface block walks the real
 * command shapes the plane builds against a healthy world and refuses any
 * refusal, the way the Stub world suite pins its own surface, so a shape the
 * plane starts sending and a shape the world never answered both show up here
 * rather than in a fallback.
 */
import { describe, expect, test } from "bun:test";
import { BYPASS_CONTRIBUTOR_PUSH_HOOK } from "../src/git-push.ts";
import { gatedRunner } from "./gated-runner.ts";
import { type HerdrWorldDescription, type StubHerdrWorld, stubHerdrWorld } from "./herdr-world.ts";

const CHECKOUT = "/home/jul/src/factory";
const OTHER_CHECKOUT = "/home/jul/src/billing";
const WORKTREES_ROOT = "/home/jul/worktrees/factory";
const CLONE_URL = "https://github.com/acme/factory.git";
const HEAD_SHA = "a11ce8f0d2b4c6e8a01234567890123456789012";

/** The healthy standing: one verified checkout, one live workspace, one Agent. */
function healthyWorld(): StubHerdrWorld {
	return stubHerdrWorld({
		checkouts: [
			{
				path: CHECKOUT,
				cloneUrl: CLONE_URL,
				defaultBranch: "main",
				head: HEAD_SHA,
				worktreesRoot: WORKTREES_ROOT,
				branches: [
					{ name: "main", local: true, remote: true },
					{ name: "factory/7-standing", local: true, remote: true },
				],
				worktrees: [
					{
						path: `${WORKTREES_ROOT}/factory-7-standing`,
						branch: "factory/7-standing",
						linked: true,
					},
				],
				remoteFiles: { "docs/agents/issue-tracker.md": "the tracked issue tracker" },
			},
		],
		workspaces: [{ id: "ws-1", checkoutPath: CHECKOUT }],
		tabs: [{ id: "tab-1", workspaceId: "ws-1", cwd: CHECKOUT }],
		panes: [{ id: "pane-1", tabId: "tab-1", workspaceId: "ws-1", content: "the pane stands" }],
		agents: [
			{ name: "worker-1", kind: "pi", status: "working", paneId: "pane-1" },
			{
				name: "settler-1",
				kind: "pi",
				status: "idle",
				paneId: "pane-2",
				sessionId: "/tmp/session-1.jsonl",
			},
		],
	} satisfies HerdrWorldDescription);
}

/** One agent row in the `agent list` answer. */
interface AgentRow {
	name?: string;
	pane_id?: string;
	tab_id?: string;
	workspace_id?: string;
	agent?: string;
	agent_status?: string;
	agent_session?: unknown;
}

/** One workspace row in the `workspace list` answer. */
interface WorkspaceRow {
	workspace_id?: string;
	focused?: boolean;
	label?: string;
	worktree?: { checkout_path?: string };
}

/** One tab row in the `tab list` answer. */
interface TabRow {
	tab_id?: string;
}

/** One pane row in the `pane list` answer. */
interface PaneRow {
	pane_id?: string;
	tab_id?: string;
}

/** One worktree row in the `worktree list` answer. */
interface WorktreeRow {
	path?: string;
	branch?: string;
	is_linked_worktree?: boolean;
	is_prunable?: boolean;
	open_workspace_id?: string;
}

/** One `worktree open` and `worktree create` answer. */
interface OpenAnswer {
	already_open?: boolean;
	workspace?: { workspace_id?: string };
	tab?: { tab_id?: string };
	worktree?: { path?: string };
}

/** One `workspace get` answer. */
interface WorkspaceGetAnswer {
	type?: string;
	workspace?: { focused?: boolean; label?: string; workspace_id?: string };
}

/** The result level of one herdr JSON answer, in the shape the reader names. */
const resultOf = <T>(stdout: string): T => JSON.parse(stdout).result as T;

/** The error code a herdr refusal carries, the way the handoff reads it. */
function herdrCode(result: { code: number; stderr: string }): string | null {
	if (result.code === 0) return null;
	try {
		return (JSON.parse(result.stderr) as { error?: { code?: string } }).error?.code ?? null;
	} catch {
		return null;
	}
}

describe("the checkout side", () => {
	test("a held checkout verifies with its remote, the way the plane reads it", async () => {
		const world = healthyWorld();
		const gitDir = await world.run("git", ["-C", CHECKOUT, "rev-parse", "--git-dir"]);
		expect(gitDir.code).toBe(0);
		expect(gitDir.stdout).toBe(".git\n");
		const remote = await world.run("git", ["-C", CHECKOUT, "remote", "get-url", "origin"]);
		expect(remote.code).toBe(0);
		expect(remote.stdout).toBe(`${CLONE_URL}\n`);
	});

	test("a path the world does not hold fails the verification with git's fatal", async () => {
		const world = healthyWorld();
		const gitDir = await world.run("git", [
			"-C",
			"/home/jul/src/missing",
			"rev-parse",
			"--git-dir",
		]);
		expect(gitDir.code).toBe(128);
		expect(gitDir.stderr).toContain("fatal:");
		const remote = await world.run("git", [
			"-C",
			"/home/jul/src/missing",
			"remote",
			"get-url",
			"origin",
		]);
		expect(remote.code).toBe(128);
	});

	test("a clone stands a checkout the later verification reads", async () => {
		const world = healthyWorld();
		const cloned = await world.run("git", ["clone", CLONE_URL, "/home/jul/src/factory_1"]);
		expect(cloned.code).toBe(0);
		const gitDir = await world.run("git", [
			"-C",
			"/home/jul/src/factory_1",
			"rev-parse",
			"--git-dir",
		]);
		expect(gitDir.code).toBe(0);
		const remote = await world.run("git", [
			"-C",
			"/home/jul/src/factory_1",
			"remote",
			"get-url",
			"origin",
		]);
		expect(remote.stdout).toBe(`${CLONE_URL}\n`);
	});
});

describe("the Worktree base side", () => {
	test("the origin/HEAD symref names the default branch, then the fetch settles", async () => {
		const world = healthyWorld();
		const symref = await world.run("git", [
			"-C",
			CHECKOUT,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
		]);
		expect(symref.code).toBe(0);
		expect(symref.stdout).toBe("refs/remotes/origin/main\n");
		const fetched = await world.run("git", ["-C", CHECKOUT, "fetch", "origin", "main"]);
		expect(fetched.code).toBe(0);
	});

	test("the candidate check passes for a held origin branch and fails for one that is not", async () => {
		const world = healthyWorld();
		const held = await world.run("git", [
			"-C",
			CHECKOUT,
			"rev-parse",
			"--verify",
			"--quiet",
			"origin/main^{commit}",
		]);
		expect(held.code).toBe(0);
		const missing = await world.run("git", [
			"-C",
			CHECKOUT,
			"rev-parse",
			"--verify",
			"--quiet",
			"origin/none^{commit}",
		]);
		expect(missing.code).toBe(1);
		expect(missing.stdout).toBe("");
	});

	test("a checkout with no symref fails the symref read and the candidate falls back", async () => {
		const world = stubHerdrWorld({
			checkouts: [
				{
					path: OTHER_CHECKOUT,
					cloneUrl: "https://github.com/acme/billing.git",
					head: "b22ce8f0d2b4c6e8a01234567890123456789012",
					branches: [{ name: "main", remote: true }],
				},
			],
		});
		const symref = await world.run("git", [
			"-C",
			OTHER_CHECKOUT,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
		]);
		expect(symref.code).toBe(1);
		const candidate = await world.run("git", [
			"-C",
			OTHER_CHECKOUT,
			"rev-parse",
			"--verify",
			"--quiet",
			"origin/main^{commit}",
		]);
		expect(candidate.code).toBe(0);
		const head = await world.run("git", ["-C", OTHER_CHECKOUT, "rev-parse", "HEAD"]);
		expect(head.stdout).toBe("b22ce8f0d2b4c6e8a01234567890123456789012\n");
	});
});

describe("the worktree side", () => {
	test("the worktree list carries the shapes the plane reads", async () => {
		const world = healthyWorld();
		const listed = await world.run("herdr", ["worktree", "list", "--cwd", CHECKOUT]);
		expect(listed.code).toBe(0);
		const worktrees = resultOf<{ worktrees: WorktreeRow[] }>(listed.stdout).worktrees;
		expect(worktrees).toHaveLength(1);
		expect(worktrees[0]).toEqual(
			expect.objectContaining({
				path: `${WORKTREES_ROOT}/factory-7-standing`,
				branch: "factory/7-standing",
				is_linked_worktree: true,
				is_prunable: false,
			}),
		);
	});

	test("a worktree create stands the worktree, the branch, the workspace, and the pane", async () => {
		const world = healthyWorld();
		const created = await world.run("herdr", [
			"worktree",
			"create",
			"--cwd",
			CHECKOUT,
			"--branch",
			"factory/9-fresh",
			"--base",
			"origin/main",
			"--no-focus",
		]);
		expect(created.code).toBe(0);
		const workspaceId = resultOf<OpenAnswer>(created.stdout).workspace?.workspace_id as string;
		const listed = await world.run("herdr", ["worktree", "list", "--cwd", CHECKOUT]);
		const worktrees = resultOf<{ worktrees: WorktreeRow[] }>(listed.stdout).worktrees;
		expect(
			worktrees.some((worktree) => worktree.path === `${WORKTREES_ROOT}/factory-9-fresh`),
		).toBe(true);
		const branch = await world.run("git", ["-C", CHECKOUT, "branch", "--list", "factory/9-fresh"]);
		expect(branch.stdout).toBe("  factory/9-fresh\n");
		// The workspace the create stands is held, and a close of it answers against it.
		const closed = await world.run("herdr", ["workspace", "close", workspaceId]);
		expect(closed.code).toBe(0);
	});

	test("a create on a branch the checkout already holds is refused", async () => {
		const world = healthyWorld();
		const created = await world.run("herdr", [
			"worktree",
			"create",
			"--cwd",
			CHECKOUT,
			"--branch",
			"main",
			"--no-focus",
		]);
		expect(created.code).toBe(1);
		expect(created.stderr).toContain("already exists");
	});

	test("a create with a base the checkout does not hold is refused", async () => {
		const world = healthyWorld();
		const created = await world.run("herdr", [
			"worktree",
			"create",
			"--cwd",
			CHECKOUT,
			"--branch",
			"factory/9-fresh",
			"--base",
			"origin/none",
			"--no-focus",
		]);
		expect(created.code).toBe(1);
	});

	test("a worktree open attaches a fresh workspace, and the second open adds a tab", async () => {
		const world = healthyWorld();
		const first = await world.run("herdr", [
			"worktree",
			"open",
			"--cwd",
			CHECKOUT,
			"--branch",
			"factory/7-standing",
			"--no-focus",
		]);
		expect(first.code).toBe(0);
		const firstResult = resultOf<OpenAnswer>(first.stdout);
		expect(firstResult.already_open).toBe(false);
		const workspaceId = firstResult.workspace?.workspace_id;
		const second = await world.run("herdr", [
			"worktree",
			"open",
			"--cwd",
			CHECKOUT,
			"--branch",
			"factory/7-standing",
			"--no-focus",
		]);
		const secondResult = resultOf<OpenAnswer>(second.stdout);
		expect(secondResult.already_open).toBe(true);
		expect(secondResult.workspace?.workspace_id).toBe(workspaceId);
		expect(secondResult.tab?.tab_id).not.toBe(firstResult.tab?.tab_id);
	});

	test("a worktree open by its path answers the same way the branch does", async () => {
		const world = healthyWorld();
		const opened = await world.run("herdr", [
			"worktree",
			"open",
			"--cwd",
			CHECKOUT,
			"--path",
			`${WORKTREES_ROOT}/factory-7-standing`,
			"--no-focus",
		]);
		expect(opened.code).toBe(0);
		const result = resultOf<OpenAnswer>(opened.stdout);
		expect(result.worktree?.path).toBe(`${WORKTREES_ROOT}/factory-7-standing`);
	});

	test("a worktree no checkout holds is refused with the plane's own code", async () => {
		const world = healthyWorld();
		const opened = await world.run("herdr", [
			"worktree",
			"open",
			"--cwd",
			CHECKOUT,
			"--branch",
			"factory/none",
			"--no-focus",
		]);
		expect(opened.code).toBe(1);
		expect(herdrCode(opened)).toBe("worktree_not_found");
	});

	test("a dirty worktree refuses a remove without force, and the force takes it down", async () => {
		const world = stubHerdrWorld({
			checkouts: [
				{
					path: CHECKOUT,
					cloneUrl: CLONE_URL,
					worktreesRoot: WORKTREES_ROOT,
					worktrees: [
						{
							path: `${WORKTREES_ROOT}/factory-8-dirty`,
							branch: "factory/8-dirty",
							dirty: true,
						},
					],
				},
			],
		});
		// The open stands the workspace the remove then answers against.
		const opened = await world.run("herdr", [
			"worktree",
			"open",
			"--cwd",
			CHECKOUT,
			"--branch",
			"factory/8-dirty",
			"--no-focus",
		]);
		const workspaceId = resultOf<OpenAnswer>(opened.stdout).workspace?.workspace_id as string;
		const refused = await world.run("herdr", ["worktree", "remove", "--workspace", workspaceId]);
		expect(refused.code).toBe(1);
		expect(herdrCode(refused)).toBe("dirty_worktree_requires_force");
		const forced = await world.run("herdr", [
			"worktree",
			"remove",
			"--workspace",
			workspaceId,
			"--force",
		]);
		expect(forced.code).toBe(0);
		const listed = await world.run("herdr", ["worktree", "list", "--cwd", CHECKOUT]);
		const worktrees = resultOf<{ worktrees: WorktreeRow[] }>(listed.stdout).worktrees;
		expect(worktrees).toHaveLength(0);
	});

	test("a remove of a workspace whose checkout is gone answers the fallback's code", async () => {
		const world = stubHerdrWorld({
			checkouts: [{ path: CHECKOUT, cloneUrl: CLONE_URL }],
			workspaces: [{ id: "ws-gone", checkoutPath: `${WORKTREES_ROOT}/factory-9-fresh` }],
		});
		const removed = await world.run("herdr", ["worktree", "remove", "--workspace", "ws-gone"]);
		expect(removed.code).toBe(1);
		expect(herdrCode(removed)).toBe("worktree_remove_failed");
	});
});

describe("the live side", () => {
	test("a workspace create stands the workspace, the tab, and the pane the plane reads", async () => {
		const world = healthyWorld();
		const created = await world.run("herdr", [
			"workspace",
			"create",
			"--cwd",
			CHECKOUT,
			"--no-focus",
		]);
		expect(created.code).toBe(0);
		const workspaceId = resultOf<OpenAnswer>(created.stdout).workspace?.workspace_id as string;
		const listed = await world.run("herdr", ["workspace", "list"]);
		const workspaces = resultOf<{ workspaces: WorkspaceRow[] }>(listed.stdout).workspaces;
		expect(
			workspaces.some(
				(workspace) =>
					workspace.workspace_id === workspaceId && workspace.worktree?.checkout_path === CHECKOUT,
			),
		).toBe(true);
	});

	test("the workspace list stands the checkout path the live environment matches on", async () => {
		const world = healthyWorld();
		const listed = await world.run("herdr", ["workspace", "list"]);
		const workspaces = resultOf<{ workspaces: WorkspaceRow[] }>(listed.stdout).workspaces;
		expect(
			workspaces.some(
				(workspace) =>
					workspace.workspace_id === "ws-1" && workspace.worktree?.checkout_path === CHECKOUT,
			),
		).toBe(true);
	});

	test("a tab create and a tab close answer against the same world", async () => {
		const world = healthyWorld();
		const created = await world.run("herdr", [
			"tab",
			"create",
			"--workspace",
			"ws-1",
			"--cwd",
			CHECKOUT,
			"--no-focus",
		]);
		const tabId = resultOf<OpenAnswer>(created.stdout).tab?.tab_id as string;
		const listed = await world.run("herdr", ["tab", "list", "--workspace", "ws-1"]);
		const tabs = resultOf<{ tabs: TabRow[] }>(listed.stdout).tabs;
		expect(tabs.some((tab) => tab.tab_id === tabId)).toBe(true);
		const closed = await world.run("herdr", ["tab", "close", tabId]);
		expect(closed.code).toBe(0);
		const after = await world.run("herdr", ["tab", "list", "--workspace", "ws-1"]);
		const rest = resultOf<{ tabs: TabRow[] }>(after.stdout).tabs;
		expect(rest.some((tab) => tab.tab_id === tabId)).toBe(false);
	});

	test("a close of a tab the world does not hold is refused with the plane's own code", async () => {
		const world = healthyWorld();
		const closed = await world.run("herdr", ["tab", "close", "tab-gone"]);
		expect(closed.code).toBe(1);
		expect(herdrCode(closed)).toBe("tab_not_found");
	});

	test("a tab in a workspace the world does not hold is refused", async () => {
		const world = healthyWorld();
		const created = await world.run("herdr", [
			"tab",
			"create",
			"--workspace",
			"ws-gone",
			"--no-focus",
		]);
		expect(created.code).toBe(1);
		expect(herdrCode(created)).toBe("workspace_not_found");
		const panes = await world.run("herdr", ["pane", "list", "--workspace", "ws-gone"]);
		expect(panes.code).toBe(1);
		expect(herdrCode(panes)).toBe("workspace_not_found");
	});

	test("a workspace close takes the tabs, the panes, and the Agents it held", async () => {
		const world = healthyWorld();
		const closed = await world.run("herdr", ["workspace", "close", "ws-1"]);
		expect(closed.code).toBe(0);
		const listed = await world.run("herdr", ["workspace", "list"]);
		const workspaces = resultOf<{ workspaces: WorkspaceRow[] }>(listed.stdout).workspaces;
		expect(workspaces.some((workspace) => workspace.workspace_id === "ws-1")).toBe(false);
		const agents = await world.run("herdr", ["agent", "list"]);
		const names = resultOf<{ agents: AgentRow[] }>(agents.stdout).agents.map((agent) => agent.name);
		expect(names).not.toContain("worker-1");
	});

	test("a close of a workspace the world does not hold is refused", async () => {
		const world = healthyWorld();
		const closed = await world.run("herdr", ["workspace", "close", "ws-gone"]);
		expect(closed.code).toBe(1);
		expect(herdrCode(closed)).toBe("workspace_not_found");
	});

	test("the pane list answers the panes the plane's topology reader matches on", async () => {
		const world = healthyWorld();
		const listed = await world.run("herdr", ["pane", "list", "--workspace", "ws-1"]);
		expect(listed.code).toBe(0);
		const panes = resultOf<{ panes: PaneRow[] }>(listed.stdout).panes;
		expect(panes.some((pane) => pane.pane_id === "pane-1" && pane.tab_id === "tab-1")).toBe(true);
	});

	test("a workspace get reads the label the plane shows", async () => {
		const world = healthyWorld();
		const got = await world.run("herdr", ["workspace", "get", "ws-1"]);
		expect(got.code).toBe(0);
		const result = resultOf<WorkspaceGetAnswer>(got.stdout);
		expect(result.workspace?.workspace_id).toBe("ws-1");
	});
});

describe("the Agent side", () => {
	test("an agent list agrees with the world's standing, and the session path rides along", async () => {
		const world = healthyWorld();
		const listed = await world.run("herdr", ["agent", "list"]);
		expect(listed.code).toBe(0);
		const agents = resultOf<{ agents: AgentRow[] }>(listed.stdout).agents;
		const worker = agents.find((agent) => agent.name === "worker-1");
		expect(worker).toEqual(
			expect.objectContaining({
				pane_id: "pane-1",
				tab_id: "tab-1",
				workspace_id: "ws-1",
				agent: "pi",
				agent_status: "working",
			}),
		);
		const settler = agents.find((agent) => agent.name === "settler-1");
		expect(settler?.agent_session).toEqual({
			kind: "path",
			source: "herdr:stub",
			value: "/tmp/session-1.jsonl",
		});
	});

	test("an agent start stands the Agent, and the later list agrees with it", async () => {
		const world = healthyWorld();
		const started = await world.run("herdr", [
			"agent",
			"start",
			"new-worker",
			"--kind",
			"pi",
			"--pane",
			"pane-1",
			"--",
			"--model",
			"test/model",
		]);
		expect(started.code).toBe(0);
		const listed = await world.run("herdr", ["agent", "list"]);
		const agents = resultOf<{ agents: AgentRow[] }>(listed.stdout).agents;
		const startedAgent = agents.find((agent) => agent.name === "new-worker");
		expect(startedAgent).toEqual(
			expect.objectContaining({
				pane_id: "pane-1",
				agent: "pi",
				agent_status: "idle",
			}),
		);
	});

	test("a name the world already holds is refused with the holder the plane parses", async () => {
		const world = healthyWorld();
		const refused = await world.run("herdr", [
			"agent",
			"start",
			"worker-1",
			"--kind",
			"pi",
			"--pane",
			"pane-1",
		]);
		expect(refused.code).toBe(1);
		expect(herdrCode(refused)).toBe("agent_name_taken");
		// The handoff's collision reader parses the holder out of this message.
		const match = /terminal_id=(\S+)\s+pane_id=(\S+)\s+workspace_id=(\S+)\s+tab_id=(\S+)/u.exec(
			refused.stderr,
		);
		expect(match).not.toBe(null);
		expect(match?.[2]).toBe("pane-1");
		expect(match?.[3]).toBe("ws-1");
	});

	test("a pane the world marks busy refuses the start with the plane's own code", async () => {
		const world = stubHerdrWorld({
			checkouts: [{ path: CHECKOUT, cloneUrl: CLONE_URL }],
			workspaces: [{ id: "ws-1", checkoutPath: CHECKOUT }],
			tabs: [{ id: "tab-1", workspaceId: "ws-1" }],
			panes: [{ id: "pane-1", tabId: "tab-1", workspaceId: "ws-1", busy: true }],
		});
		const refused = await world.run("herdr", [
			"agent",
			"start",
			"worker-1",
			"--kind",
			"pi",
			"--pane",
			"pane-1",
		]);
		expect(refused.code).toBe(1);
		expect(herdrCode(refused)).toBe("agent_pane_busy");
	});

	test("a start in a pane the world does not hold is refused", async () => {
		const world = healthyWorld();
		const refused = await world.run("herdr", [
			"agent",
			"start",
			"worker-fresh",
			"--kind",
			"pi",
			"--pane",
			"pane-gone",
		]);
		expect(refused.code).toBe(1);
		expect(herdrCode(refused)).toBe("agent_start_failed");
	});

	test("an agent read answers the pane's content, and a read of a missing pane is refused", async () => {
		const world = healthyWorld();
		const read = await world.run("herdr", [
			"agent",
			"read",
			"pane-1",
			"--lines",
			"50",
			"--source",
			"visible",
			"--format",
			"ansi",
		]);
		expect(read.code).toBe(0);
		expect(read.stdout).toBe("the pane stands");
		const missing = await world.run("herdr", [
			"agent",
			"read",
			"pane-gone",
			"--lines",
			"50",
			"--source",
			"visible",
			"--format",
			"ansi",
		]);
		expect(missing.code).toBe(1);
	});

	test("a prompt of a held Agent settles, and a prompt of one that is not is refused", async () => {
		const world = healthyWorld();
		const sent = await world.run("herdr", ["agent", "prompt", "worker-1", "go"]);
		expect(sent.code).toBe(0);
		const missing = await world.run("herdr", ["agent", "prompt", "worker-gone", "go"]);
		expect(missing.code).toBe(1);
	});

	test("an agent focus settles for a held pane and refuses for one that is not", async () => {
		const world = healthyWorld();
		const focused = await world.run("herdr", ["agent", "focus", "pane-1"]);
		expect(focused.code).toBe(0);
		const missing = await world.run("herdr", ["agent", "focus", "pane-gone"]);
		expect(missing.code).toBe(1);
	});

	test("an agent wait settles at a settle state and holds for every other target", async () => {
		const world = healthyWorld();
		const settled = await world.run("herdr", [
			"agent",
			"wait",
			"settler-1",
			"--until",
			"idle",
			"--until",
			"done",
			"--until",
			"blocked",
		]);
		expect(settled.code).toBe(0);
		// The working Agent holds, the way the real command blocks: the command
		// is recorded, and it never settles.
		const held = world.run("herdr", [
			"agent",
			"wait",
			"worker-1",
			"--until",
			"idle",
			"--until",
			"done",
			"--until",
			"blocked",
		]);
		await Promise.resolve();
		expect(world.commands()).toContain(
			"herdr agent wait worker-1 --until idle --until done --until blocked",
		);
		expect(world.settledCommands()).not.toContain(
			"herdr agent wait worker-1 --until idle --until done --until blocked",
		);
		void held;
	});

	test("a setAgentStatus move stands the next list and the wait the plane reads", async () => {
		const world = healthyWorld();
		world.setAgentStatus("worker-1", "done", "/tmp/session-2.jsonl");
		const listed = await world.run("herdr", ["agent", "list"]);
		const agent = resultOf<{ agents: AgentRow[] }>(listed.stdout).agents.find(
			(item) => item.name === "worker-1",
		);
		expect(agent?.agent_status).toBe("done");
		expect(agent?.agent_session).toEqual({
			kind: "path",
			source: "herdr:stub",
			value: "/tmp/session-2.jsonl",
		});
		const waited = await world.run("herdr", [
			"agent",
			"wait",
			"worker-1",
			"--until",
			"idle",
			"--until",
			"done",
			"--until",
			"blocked",
		]);
		expect(waited.code).toBe(0);
		expect(() => world.setAgentStatus("worker-gone", "done")).toThrow();
	});

	test("a pane send-text and a send-keys answer the pane and record what reached it", async () => {
		const world = healthyWorld();
		const text = await world.run("herdr", ["pane", "send-text", "pane-1", "hello", "world"]);
		expect(text.code).toBe(0);
		const key = await world.run("herdr", ["pane", "send-keys", "pane-1", "enter"]);
		expect(key.code).toBe(0);
		expect(world.sentTextFor("pane-1")).toEqual(["hello", "world"]);
		expect(world.sentKeysFor("pane-1")).toEqual(["enter"]);
		const missing = await world.run("herdr", ["pane", "send-text", "pane-gone", "hello"]);
		expect(missing.code).toBe(1);
	});
});

describe("the git write side", () => {
	test("the branch reads and the delete answer against the same world", async () => {
		const world = healthyWorld();
		const listed = await world.run("git", [
			"-C",
			CHECKOUT,
			"branch",
			"--list",
			"factory/7-standing",
		]);
		expect(listed.stdout).toBe("  factory/7-standing\n");
		const deleted = await world.run("git", ["-C", CHECKOUT, "branch", "-D", "factory/7-standing"]);
		expect(deleted.code).toBe(0);
		expect(deleted.stdout).toContain("Deleted branch factory/7-standing");
		const after = await world.run("git", [
			"-C",
			CHECKOUT,
			"branch",
			"--list",
			"factory/7-standing",
		]);
		expect(after.stdout).toBe("");
		const missing = await world.run("git", ["-C", CHECKOUT, "branch", "-D", "factory/none"]);
		expect(missing.code).toBe(128);
	});

	test("the tip and tree read answers both refs beside the branch", async () => {
		const world = healthyWorld();
		const refs = await world.run("git", [
			"-C",
			CHECKOUT,
			"rev-parse",
			"factory/7-standing",
			"factory/7-standing^{tree}",
		]);
		expect(refs.code).toBe(0);
		const lines = refs.stdout.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toHaveLength(40);
		const commit = await world.run("git", [
			"-C",
			CHECKOUT,
			"commit-tree",
			lines[1],
			"-p",
			lines[0],
			"-m",
			"a hold commit",
		]);
		expect(commit.code).toBe(0);
		expect(commit.stdout.trim()).toHaveLength(40);
		const moved = await world.run("git", [
			"-C",
			CHECKOUT,
			"update-ref",
			"refs/heads/factory/7-standing",
			commit.stdout.trim(),
		]);
		expect(moved.code).toBe(0);
	});

	test("a push lands the branch on origin, and the ls-remote reads it back", async () => {
		const world = healthyWorld();
		const before = await world.run("git", [
			"-C",
			CHECKOUT,
			"ls-remote",
			"--heads",
			"origin",
			"factory/7-standing",
		]);
		expect(before.stdout).not.toBe("");
		const pushed = await world.run("git", [
			"-C",
			CHECKOUT,
			"push",
			...BYPASS_CONTRIBUTOR_PUSH_HOOK,
			"origin",
			"factory/7-standing",
		]);
		expect(pushed.code).toBe(0);
		const after = await world.run("git", [
			"-C",
			CHECKOUT,
			"ls-remote",
			"--heads",
			"origin",
			"factory/7-standing",
		]);
		expect(after.stdout).toContain("refs/heads/factory/7-standing");
		const missing = await world.run("git", [
			"-C",
			CHECKOUT,
			"push",
			...BYPASS_CONTRIBUTOR_PUSH_HOOK,
			"origin",
			"factory/none",
		]);
		expect(missing.code).toBe(1);
	});

	test("the quiet diff answers alike trees with zero and apart trees with one", async () => {
		const world = healthyWorld();
		// Both branches stand on origin with the same tree only when they hold
		// the same commit: the plane's pullRequestCarriesWork reads that.
		const alike = await world.run("git", [
			"-C",
			CHECKOUT,
			"diff",
			"--quiet",
			"origin/main",
			"origin/main",
		]);
		expect(alike.code).toBe(0);
		const apart = await world.run("git", [
			"-C",
			CHECKOUT,
			"diff",
			"--quiet",
			"origin/main",
			"origin/factory/7-standing",
		]);
		expect(apart.code).toBe(1);
		// A branch origin does not carry fails the read, the way the remote refuses.
		const missing = await world.run("git", [
			"-C",
			CHECKOUT,
			"diff",
			"--quiet",
			"origin/none",
			"origin/main",
		]);
		expect(missing.code).toBe(128);
		// A hold commit carries the base's tree, so the diff reads no work.
		const refs = await world.run("git", [
			"-C",
			CHECKOUT,
			"rev-parse",
			"factory/7-standing",
			"factory/7-standing^{tree}",
		]);
		const [, baseTree] = (
			await world.run("git", ["-C", CHECKOUT, "rev-parse", "main", "main^{tree}"])
		).stdout
			.trim()
			.split("\n");
		const lines = refs.stdout.trim().split("\n");
		const held = await world.run("git", [
			"-C",
			CHECKOUT,
			"commit-tree",
			baseTree,
			"-p",
			lines[0],
			"-m",
			"factory: hold the branch for the pull request",
		]);
		await world.run("git", [
			"-C",
			CHECKOUT,
			"update-ref",
			"refs/heads/factory/7-standing",
			held.stdout.trim(),
		]);
		await world.run("git", [
			"-C",
			CHECKOUT,
			"fetch",
			"origin",
			"factory/7-standing:refs/heads/factory/7-standing",
		]);
		const heldDiff = await world.run("git", [
			"-C",
			CHECKOUT,
			"diff",
			"--quiet",
			"origin/main",
			"origin/factory/7-standing",
		]);
		expect(heldDiff.code).toBe(0);
	});

	test("a standing remote fetch lands the local copy the branch check reads", async () => {
		const world = healthyWorld();
		const fetched = await world.run("git", [
			"-C",
			CHECKOUT,
			"fetch",
			"origin",
			"factory/7-standing:refs/heads/factory/7-standing",
		]);
		expect(fetched.code).toBe(0);
		const listed = await world.run("git", [
			"-C",
			CHECKOUT,
			"branch",
			"--list",
			"factory/7-standing",
		]);
		expect(listed.stdout).toBe("  factory/7-standing\n");
	});

	test("the init's throwaway worktree answers the add, the writes, and the push", async () => {
		const world = healthyWorld();
		const added = await world.run("git", [
			"-C",
			CHECKOUT,
			"worktree",
			"add",
			"--detach",
			"/tmp/init-worktree",
			"origin/main",
		]);
		expect(added.code).toBe(0);
		const staged = await world.run("git", ["-C", "/tmp/init-worktree", "add", "-A"]);
		expect(staged.code).toBe(0);
		const status = await world.run("git", ["-C", "/tmp/init-worktree", "status", "--porcelain"]);
		expect(status.stdout.trim()).not.toBe("");
		const committed = await world.run("git", [
			"-C",
			"/tmp/init-worktree",
			"commit",
			"-m",
			"Initialize factory for the factory",
		]);
		expect(committed.code).toBe(0);
		const head = await world.run("git", ["-C", "/tmp/init-worktree", "rev-parse", "HEAD"]);
		expect(head.stdout.trim()).toHaveLength(40);
		const pushed = await world.run("git", [
			"-C",
			"/tmp/init-worktree",
			"push",
			...BYPASS_CONTRIBUTOR_PUSH_HOOK,
			"origin",
			"HEAD:main",
		]);
		expect(pushed.code).toBe(0);
		const removed = await world.run("git", [
			"-C",
			CHECKOUT,
			"worktree",
			"remove",
			"--force",
			"/tmp/init-worktree",
		]);
		expect(removed.code).toBe(0);
	});

	test("the checkout status read answers the dirty standing, with and without the untracked flag", async () => {
		const world = stubHerdrWorld({
			checkouts: [
				{ path: CHECKOUT, cloneUrl: CLONE_URL, dirty: true },
				{ path: OTHER_CHECKOUT, cloneUrl: "https://github.com/acme/billing.git" },
			],
		});
		const dirty = await world.run("git", [
			"-C",
			CHECKOUT,
			"status",
			"--porcelain",
			"--untracked-files=all",
		]);
		expect(dirty.code).toBe(0);
		expect(dirty.stdout.trim()).not.toBe("");
		const clean = await world.run("git", ["-C", OTHER_CHECKOUT, "status", "--porcelain"]);
		expect(clean.code).toBe(0);
		expect(clean.stdout).toBe("");
	});

	test("a remote file read answers the tracked file and refuses the missing one", async () => {
		const world = healthyWorld();
		const shown = await world.run("git", [
			"-C",
			CHECKOUT,
			"show",
			"origin/main:docs/agents/issue-tracker.md",
		]);
		expect(shown.code).toBe(0);
		expect(shown.stdout).toBe("the tracked issue tracker");
		const missing = await world.run("git", [
			"-C",
			CHECKOUT,
			"show",
			"origin/main:docs/agents/missing.md",
		]);
		expect(missing.code).toBe(128);
	});
});

describe("the recording", () => {
	test("the recorded list keeps the fake runner's shape beside the settled list", async () => {
		const world = healthyWorld();
		await world.run("herdr", ["workspace", "list"]);
		await world.run("git", ["-C", CHECKOUT, "rev-parse", "HEAD"]);
		expect(world.commands()).toEqual(["herdr workspace list", `git -C ${CHECKOUT} rev-parse HEAD`]);
		expect(world.settledCommands()).toEqual(world.commands());
	});

	test("a held command stays counted as running until the release lets it answer", async () => {
		const world = healthyWorld();
		const args = ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"];
		world.hold("herdr", args);
		const first = world.run("herdr", args);
		const second = world.run("herdr", ["workspace", "list"]);
		expect(world.peakConcurrency()).toBe(2);
		world.release("herdr", args);
		await first;
		await second;
		expect(world.commands()).toContain(`herdr workspace create --cwd ${CHECKOUT} --no-focus`);
		expect(world.settledCommands()).toContain(
			`herdr workspace create --cwd ${CHECKOUT} --no-focus`,
		);
	});

	test("a raised command is recorded, never settles, and fails the caller", async () => {
		const world = healthyWorld();
		world.raise("herdr", ["agent", "prompt", "worker-1", "go"], "the raise");
		await expect(world.run("herdr", ["agent", "prompt", "worker-1", "go"])).rejects.toThrow(
			"the raise",
		);
		expect(world.commands()).toContain("herdr agent prompt worker-1 go");
		expect(world.settledCommands()).not.toContain("herdr agent prompt worker-1 go");
	});

	test("a per-command sequence answers in call order", async () => {
		const world = healthyWorld();
		world.setSequence(
			"herdr",
			["worktree", "remove", "--workspace", "ws-1"],
			[
				{
					code: 1,
					stderr: '{"error":{"code":"dirty_worktree_requires_force","message":"dirty"}}\n',
				},
				{},
			],
		);
		const first = await world.run("herdr", ["worktree", "remove", "--workspace", "ws-1"]);
		expect(first.code).toBe(1);
		const second = await world.run("herdr", ["worktree", "remove", "--workspace", "ws-1"]);
		expect(second.code).toBe(0);
	});

	test("a pinned answer stands in place of the world's own for one exact command", async () => {
		const world = healthyWorld();
		world.set("herdr", ["workspace", "list"], { stdout: '{"result":{"workspaces":[]}}' });
		const listed = await world.run("herdr", ["workspace", "list"]);
		expect(listed.stdout).toBe('{"result":{"workspaces":[]}}');
	});

	test("the gate wrapper composes over the world unchanged", async () => {
		const world = healthyWorld();
		const gate = gatedRunner(world, (command) => command === "herdr workspace list");
		const listed = gate.runner.run("herdr", ["workspace", "list"]);
		expect(gate.busy()).toBe(true);
		gate.release();
		await listed;
		expect(gate.busy()).toBe(false);
		expect(world.commands()).toContain("herdr workspace list");
	});

	test("a Model list query is recorded, and a held list answers the plane", async () => {
		const world = healthyWorld();
		const missing = await world.listModels("pi");
		expect(missing.ok).toBe(false);
		world.setModelList("pi", ["test/model-a", "test/model-b"]);
		const held = await world.listModels("pi");
		expect(held).toEqual({ ok: true, models: ["test/model-a", "test/model-b"] });
		expect(world.modelListCalls).toEqual(["pi", "pi"]);
	});
});

describe("the closed surface", () => {
	test("the real command shapes the plane issues meet no refusal", async () => {
		const world = healthyWorld();
		const settled = async (command: string, args: readonly string[]): Promise<void> => {
			const result = await world.run(command, args);
			expect(result.code, `${command} ${args.join(" ")}`).toBe(0);
		};
		const BRANCH = "factory/9-fresh";

		// The herdr shapes, in the surface the plane builds.
		await settled("herdr", ["agent", "list"]);
		await settled("herdr", [
			"agent",
			"wait",
			"settler-1",
			"--until",
			"idle",
			"--until",
			"done",
			"--until",
			"blocked",
		]);
		await settled("herdr", [
			"agent",
			"read",
			"pane-1",
			"--lines",
			"50",
			"--source",
			"visible",
			"--format",
			"ansi",
		]);
		await settled("herdr", ["agent", "focus", "pane-1"]);
		await settled("herdr", ["agent", "prompt", "worker-1", "go"]);
		await settled("herdr", [
			"agent",
			"start",
			"closed-surface",
			"--kind",
			"pi",
			"--pane",
			"pane-1",
		]);
		await settled("herdr", ["pane", "send-keys", "pane-1", "enter"]);
		await settled("herdr", ["pane", "send-text", "pane-1", "hello"]);
		await settled("herdr", ["pane", "list", "--workspace", "ws-1"]);
		await settled("herdr", [
			"tab",
			"create",
			"--workspace",
			"ws-1",
			"--cwd",
			CHECKOUT,
			"--no-focus",
		]);
		await settled("herdr", ["tab", "list", "--workspace", "ws-1"]);
		await settled("herdr", ["workspace", "list"]);
		await settled("herdr", ["workspace", "create", "--cwd", CHECKOUT, "--no-focus"]);
		await settled("herdr", ["workspace", "get", "ws-1"]);
		await settled("herdr", ["worktree", "list", "--cwd", CHECKOUT]);
		await settled("herdr", [
			"worktree",
			"open",
			"--cwd",
			CHECKOUT,
			"--branch",
			"factory/7-standing",
			"--no-focus",
		]);
		await settled("herdr", [
			"worktree",
			"open",
			"--cwd",
			CHECKOUT,
			"--path",
			`${WORKTREES_ROOT}/factory-7-standing`,
			"--no-focus",
		]);
		await settled("herdr", [
			"worktree",
			"create",
			"--cwd",
			CHECKOUT,
			"--branch",
			BRANCH,
			"--base",
			"origin/main",
			"--no-focus",
		]);

		// The created worktree's workspace answers the remove and the close.
		const created = resultOf<{ worktrees: WorktreeRow[] }>(
			(await world.run("herdr", ["worktree", "list", "--cwd", CHECKOUT])).stdout,
		);
		const fresh = created.worktrees.find(
			(worktree) => worktree.path === `${WORKTREES_ROOT}/factory-9-fresh`,
		);
		expect(fresh).toBeDefined();
		const workspaceId = fresh?.open_workspace_id as string;
		await settled("herdr", ["worktree", "remove", "--workspace", workspaceId]);
		await settled("herdr", ["tab", "close", "tab-1"]);
		await settled("herdr", ["workspace", "close", "ws-1"]);

		// The git shapes, in the surface the plane builds.
		await settled("git", ["-C", CHECKOUT, "rev-parse", "--git-dir"]);
		await settled("git", ["-C", CHECKOUT, "remote", "get-url", "origin"]);
		await settled("git", ["-C", CHECKOUT, "symbolic-ref", "refs/remotes/origin/HEAD"]);
		await settled("git", [
			"-C",
			CHECKOUT,
			"rev-parse",
			"--verify",
			"--quiet",
			"origin/main^{commit}",
		]);
		await settled("git", ["-C", CHECKOUT, "fetch", "origin", "main"]);
		await settled("git", [
			"-C",
			CHECKOUT,
			"fetch",
			"origin",
			"factory/7-standing:refs/heads/factory/7-standing",
		]);
		await settled("git", ["-C", CHECKOUT, "fetch", "origin", "head-branch", "base-branch"]);
		await settled("git", ["-C", CHECKOUT, "branch", "--list", "main"]);
		await settled("git", ["-C", CHECKOUT, "rev-parse", "HEAD"]);
		await settled("git", ["-C", CHECKOUT, "branch", "--list", "factory/7-standing"]);
		await settled("git", [
			"-C",
			CHECKOUT,
			"rev-parse",
			"factory/7-standing",
			"factory/7-standing^{tree}",
		]);
		await settled("git", [
			"-C",
			CHECKOUT,
			"commit-tree",
			"tree-shape",
			"-p",
			HEAD_SHA,
			"-m",
			"factory: hold the branch for the pull request",
		]);
		await settled("git", ["-C", CHECKOUT, "update-ref", "refs/heads/factory/7-standing", HEAD_SHA]);
		await settled("git", [
			"-C",
			CHECKOUT,
			"push",
			...BYPASS_CONTRIBUTOR_PUSH_HOOK,
			"origin",
			"factory/7-standing",
		]);
		await settled("git", ["-C", CHECKOUT, "ls-remote", "--heads", "origin", "factory/7-standing"]);
		// The quiet diff is not a refusal: 0 alike and 1 apart both stand.
		const diffed = await world.run("git", [
			"-C",
			CHECKOUT,
			"diff",
			"--quiet",
			"origin/main",
			"origin/factory/7-standing",
		]);
		expect([0, 1]).toContain(diffed.code);
		await settled("git", [
			"-C",
			CHECKOUT,
			"worktree",
			"add",
			"--detach",
			"/tmp/init-worktree",
			"origin/main",
		]);
		await settled("git", ["-C", "/tmp/init-worktree", "add", "-A"]);
		await settled("git", ["-C", "/tmp/init-worktree", "status", "--porcelain"]);
		await settled("git", ["-C", "/tmp/init-worktree", "commit", "-m", "Initialize factory"]);
		await settled("git", ["-C", "/tmp/init-worktree", "rev-parse", "HEAD"]);
		await settled("git", [
			"-C",
			"/tmp/init-worktree",
			"push",
			...BYPASS_CONTRIBUTOR_PUSH_HOOK,
			"origin",
			"HEAD:main",
		]);
		await settled("git", ["-C", CHECKOUT, "worktree", "remove", "--force", "/tmp/init-worktree"]);
		await settled("git", ["-C", CHECKOUT, "show", "origin/main:docs/agents/issue-tracker.md"]);
		await settled("git", ["clone", CLONE_URL, "/home/jul/src/factory_2"]);

		// The held `agent wait` is not a refusal: it is recorded, and it does
		// not settle, the way the real command blocks.
		const heldWait = world.run("herdr", [
			"agent",
			"wait",
			"worker-1",
			"--until",
			"idle",
			"--until",
			"done",
			"--until",
			"blocked",
		]);
		await Promise.resolve();
		expect(world.commands()).toContain(
			"herdr agent wait worker-1 --until idle --until done --until blocked",
		);
		expect(world.settledCommands()).not.toContain(
			"herdr agent wait worker-1 --until idle --until done --until blocked",
		);
		void heldWait;
	});

	test("a command no side of the world models is refused, never a silent success", async () => {
		const world = healthyWorld();
		const gh = await world.run("gh", [
			"api",
			"--hostname",
			"github.com",
			"repos/acme/factory/issues",
		]);
		expect(gh.code).toBe(1);
		expect(gh.stderr).toContain("the Stub herdr world answers no gh api");
		const unknownHerdr = await world.run("herdr", ["pane", "split", "pane-1"]);
		expect(unknownHerdr.code).toBe(1);
		expect(unknownHerdr.stderr).toContain("the Stub herdr world answers no herdr pane split");
		const unknownGit = await world.run("git", ["-C", CHECKOUT, "log", "--oneline"]);
		expect(unknownGit.code).toBe(1);
		expect(unknownGit.stderr).toContain("the Stub herdr world answers no git log");
	});
});
