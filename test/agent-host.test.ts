/**
 * The Agent host module (issue #407, ADR 0141), tested at its interface.
 *
 * The module owns three host facts the surfaces may not bypass, and this file
 * holds each one at the module's interface:
 *
 * - the host word map, as one table. Each status word and each refusal code
 *   answers its named plane fact, and the table the module exports holds
 *   exactly the rows this file declares, so a mapping cannot be added or
 *   dropped on one side without the other going red.
 * - the two command dialects. Every argv shape the module answers is pinned
 *   here, at the builder, so a host that reshapes a command is a test red at
 *   the one seam that owns the shape.
 * - the host resolution, and the answer readers that turn a host's raw
 *   answer into a plane fact.
 *
 * The command the plane really sends through the runner seam is walked by the
 * closed-surface check in `test/herdr-world.test.ts`, against the Stub herdr
 * world; this file pins the argv the module answers and the facts it reads
 * back, and it touches no real host session.
 */

import { describe, expect, test } from "bun:test";

import {
	type AgentStatus,
	agentHostBootLine,
	HERDR_AGENT_WAIT_UNTIL,
	HERDR_COMMAND,
	HERDR_CORE_COMMAND,
	HERDR_CORE_VERSION_FLOOR,
	HOST_WORD_TABLE,
	type HostInvocation,
	herdrAgentFocus,
	herdrAgentList,
	herdrAgentPrompt,
	herdrAgentRead,
	herdrAgentStart,
	herdrAgentWait,
	herdrCoreErrorKind,
	herdrCoreFailureText,
	herdrCoreFloorWarningLine,
	herdrCoreGet,
	herdrCoreKill,
	herdrCoreList,
	herdrCoreRead,
	herdrCoreRecord,
	herdrCoreRefusalFact,
	herdrCoreRemove,
	herdrCoreRoster,
	herdrCoreRun,
	herdrCoreSend,
	herdrCoreVersionOf,
	herdrCoreVersionRead,
	herdrCoreWait,
	herdrErrorCode,
	herdrFailureText,
	herdrHandles,
	herdrNameHolders,
	herdrPaneClose,
	herdrPaneList,
	herdrPaneReleaseAgent,
	herdrPaneReportAgent,
	herdrPaneSendKeys,
	herdrPaneSendText,
	herdrRefusalFact,
	herdrTabClose,
	herdrTabCreate,
	herdrTabList,
	herdrWorkspaceClose,
	herdrWorkspaceCreate,
	herdrWorkspaceGet,
	herdrWorkspaceList,
	herdrWorktreeCreate,
	herdrWorktreeList,
	herdrWorktreeOpen,
	herdrWorktreeRemove,
	jsonResultField,
	normalizeAgentStatus,
	type RefusalFact,
	resolveAgentHost,
	versionIsBelow,
	worktreeAlreadyOpen,
} from "../src/agent-host.ts";
import type { CommandResult } from "../src/runner.ts";

// ---------------------------------------------------------------------------
// The host resolution
// ---------------------------------------------------------------------------

describe("the host resolution (ADR 0141)", () => {
	test("an operator config that names a host wins", () => {
		expect(resolveAgentHost("herdr", { herdrEnv: undefined, hcTerminalId: undefined })).toEqual({
			host: "herdr",
			fact: "config",
		});
		expect(resolveAgentHost("herdr-core", { herdrEnv: "1", hcTerminalId: "t1" })).toEqual({
			host: "herdr-core",
			fact: "config",
		});
	});

	test("with no config, the in-herdr mark names herdr", () => {
		expect(resolveAgentHost(undefined, { herdrEnv: "1", hcTerminalId: undefined })).toEqual({
			host: "herdr",
			fact: "herdr-mark",
		});
	});

	test("with no config and no herdr mark, the herdr-core mark names herdr-core", () => {
		expect(resolveAgentHost(undefined, { herdrEnv: "", hcTerminalId: "t1" })).toEqual({
			host: "herdr-core",
			fact: "herdr-core-mark",
		});
	});

	test("with both marks standing, the herdr mark wins", () => {
		expect(resolveAgentHost(undefined, { herdrEnv: "1", hcTerminalId: "t1" })).toEqual({
			host: "herdr",
			fact: "herdr-mark",
		});
	});

	test("with neither mark, the default is herdr-core", () => {
		expect(resolveAgentHost(undefined, { herdrEnv: undefined, hcTerminalId: undefined })).toEqual({
			host: "herdr-core",
			fact: "default",
		});
	});

	test("a config value that names no host is no key at all", () => {
		// The config rule validates the key before the value reaches the
		// resolution: a value outside the two host names is a boot refusal, so
		// the resolution sees only a host name or no key. A value it does not
		// name resolves from the marks, the way an absent key does.
		expect(resolveAgentHost("auto", { herdrEnv: "1", hcTerminalId: undefined })).toEqual({
			host: "herdr",
			fact: "herdr-mark",
		});
		expect(resolveAgentHost("auto", { herdrEnv: undefined, hcTerminalId: undefined })).toEqual({
			host: "herdr-core",
			fact: "default",
		});
	});
});

// ---------------------------------------------------------------------------
// The boot statement and the version floor
// ---------------------------------------------------------------------------

describe("the boot statement (issue #408, ADR 0141)", () => {
	test("the line names the host it resolved and the fact that resolved it", () => {
		expect(agentHostBootLine({ host: "herdr", fact: "herdr-mark" })).toBe(
			"agent host: herdr (resolved from the herdr mark; the first herdr-core read starts that session's core when none runs)",
		);
		expect(agentHostBootLine({ host: "herdr", fact: "config" })).toBe(
			"agent host: herdr (resolved from the config; the first herdr-core read starts that session's core when none runs)",
		);
		expect(agentHostBootLine({ host: "herdr-core", fact: "herdr-core-mark" })).toBe(
			"agent host: herdr-core (resolved from the herdr-core mark; the first herdr-core read starts that session's core when none runs)",
		);
		expect(agentHostBootLine({ host: "herdr-core", fact: "config" })).toBe(
			"agent host: herdr-core (resolved from the config; the first herdr-core read starts that session's core when none runs)",
		);
		expect(agentHostBootLine({ host: "herdr-core", fact: "default" })).toBe(
			"agent host: herdr-core (resolved from the default; the first herdr-core read starts that session's core when none runs)",
		);
	});
});

describe("the herdr-core version floor (ADR 0141)", () => {
	test("the floor stands on the release the shapes were read against", () => {
		expect(HERDR_CORE_VERSION_FLOOR).toBe("0.1.20");
	});

	test("the version read takes the binary the table names, and the host's word where it names none", () => {
		expect(herdrCoreVersionRead()).toEqual({ command: "hc", args: ["--version"] });
		expect(herdrCoreVersionRead("/opt/hc/bin/hc")).toEqual({
			command: "/opt/hc/bin/hc",
			args: ["--version"],
		});
	});

	test("the version one --version answer carries", () => {
		expect(herdrCoreVersionOf({ code: 0, stdout: "hc 0.1.20\n", stderr: "" })).toBe("0.1.20");
		// A tool manager's preamble stands above the answer's line: the read
		// takes the first line that carries a version, not the first line.
		expect(herdrCoreVersionOf({ code: 0, stdout: "some manager\nhc 0.1.20\n", stderr: "" })).toBe(
			"0.1.20",
		);
		// A failed command and an answer that names no version carry none.
		expect(
			herdrCoreVersionOf({ code: 127, stdout: "hc 0.1.20\n", stderr: "not found" }),
		).toBeNull();
		expect(herdrCoreVersionOf({ code: 0, stdout: "", stderr: "" })).toBeNull();
		expect(herdrCoreVersionOf({ code: 0, stdout: "no number here\n", stderr: "" })).toBeNull();
	});

	test("a version below the floor reads as below, on the digits", () => {
		expect(versionIsBelow("0.1.9", HERDR_CORE_VERSION_FLOOR)).toBe(true);
		expect(versionIsBelow("0.1.20", HERDR_CORE_VERSION_FLOOR)).toBe(false);
		expect(versionIsBelow("0.1.21", HERDR_CORE_VERSION_FLOOR)).toBe(false);
		expect(versionIsBelow("0.2.0", HERDR_CORE_VERSION_FLOOR)).toBe(false);
		// Digits, not the string: 0.1.9 stands below 0.1.20, which a string
		// compare reads the other way.
		expect(versionIsBelow("0.1.9", "0.1.20")).toBe(true);
		expect(versionIsBelow("0.1.9", "0.1.10")).toBe(true);
	});

	test("the warning line names the host version and the floor", () => {
		expect(herdrCoreFloorWarningLine("0.1.9")).toBe(
			`the herdr-core host is 0.1.9, below the plane's version floor ${HERDR_CORE_VERSION_FLOOR}: ` +
				"the plane's answer shapes were read on the floor, and a shape that host refuses comes back as that host's own reason",
		);
	});
});

// ---------------------------------------------------------------------------
// The host word map, as one table
// ---------------------------------------------------------------------------

/** The status words both hosts report, and the plane status each answers. */
const STATUS_WORDS: Array<[word: string, status: AgentStatus]> = [
	["working", "working"],
	["idle", "idle"],
	["done", "done"],
	["blocked", "blocked"],
	["error", "unknown"],
];

/** The refusal codes herdr answers, and the plane fact each answers. */
const HERDR_REFUSALS: Array<[word: string, fact: RefusalFact]> = [
	["agent_name_taken", "agent_name_taken"],
	["agent_pane_busy", "agent_pane_busy"],
	["workspace_not_found", "workspace_not_found"],
	["tab_not_found", "tab_not_found"],
	["worktree_not_found", "worktree_not_found"],
	["worktree_remove_failed", "worktree_remove_failed"],
];

/** The refusal kinds hc answers, and the plane fact each answers. */
const HERDR_CORE_REFUSALS: Array<[word: string, fact: RefusalFact]> = [
	["name_taken", "agent_name_taken"],
	["not_found", "terminal_not_found"],
	["finished", "terminal_finished"],
	["live", "terminal_live"],
	["blocked", "terminal_blocked"],
	["status_mismatch", "other"],
	["spawn_failed", "other"],
];

/** One failed herdr answer carrying a refusal code on its JSON stderr. */
function herdrRefusal(code: string): CommandResult {
	return { code: 1, stdout: "", stderr: JSON.stringify({ error: { code } }) };
}

/** One failed herdr-core answer carrying a refusal kind on its JSON stderr. */
function herdrCoreRefusal(kind: string): CommandResult {
	return { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind } }) };
}

describe("the host word map is one table", () => {
	test("each status word answers its plane status", () => {
		for (const [word, status] of STATUS_WORDS) {
			expect(normalizeAgentStatus(word), word).toBe(status);
		}
	});

	test("a status word the table does not name reads as unknown", () => {
		expect(normalizeAgentStatus("spinning")).toBe("unknown");
		expect(normalizeAgentStatus("")).toBe("unknown");
	});

	test("each herdr refusal answers its plane fact", () => {
		for (const [word, fact] of HERDR_REFUSALS) {
			expect(herdrRefusalFact(herdrRefusal(word)), word).toBe(fact);
		}
	});

	test("each herdr-core refusal answers its plane fact", () => {
		for (const [word, fact] of HERDR_CORE_REFUSALS) {
			expect(herdrCoreRefusalFact(herdrCoreRefusal(word)), word).toBe(fact);
		}
	});

	test("a refusal word the table does not name reads as other", () => {
		expect(herdrRefusalFact(herdrRefusal("agent_weird"))).toBe("other");
		expect(herdrCoreRefusalFact(herdrCoreRefusal("weird"))).toBe("other");
	});

	test("the table holds exactly the words this file declares", () => {
		// The guard that keeps the map a table: a row the module adds that this
		// file does not declare, or a row this file declares that the module
		// drops, changes the count and goes red here.
		const declared = STATUS_WORDS.length + HERDR_REFUSALS.length + HERDR_CORE_REFUSALS.length;
		expect(HOST_WORD_TABLE).toHaveLength(declared);
		for (const row of HOST_WORD_TABLE) {
			if ("status" in row) {
				expect(STATUS_WORDS, `status row ${row.word}`).toContainEqual([row.word, row.status]);
			} else {
				const expected = row.host === "herdr" ? HERDR_REFUSALS : HERDR_CORE_REFUSALS;
				expect(expected, `${row.host} row ${row.word}`).toContainEqual([row.word, row.fact]);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// The herdr dialect: the argv shapes the module answers
// ---------------------------------------------------------------------------

describe("the herdr dialect answers the argv the plane builds", () => {
	test("the host command word is the first field of every invocation", () => {
		const invocations: HostInvocation[] = [
			herdrAgentList(),
			herdrAgentStart("worker-1", "pi", "pane-1"),
			herdrAgentPrompt("worker-1", "go"),
			herdrAgentWait("worker-1"),
			herdrAgentRead("pane-1", 50, "visible", "ansi"),
			herdrAgentFocus("pane-1"),
			herdrWorkspaceList(),
			herdrWorkspaceGet("ws-1"),
			herdrWorkspaceCreate("/repo"),
			herdrWorkspaceClose("ws-1"),
			herdrTabCreate("ws-1", "/repo"),
			herdrTabList("ws-1"),
			herdrTabClose("tab-1"),
			herdrPaneList("ws-1"),
			herdrPaneClose("pane-1"),
			herdrPaneSendKeys("pane-1", "enter"),
			herdrPaneSendText("pane-1", "hello"),
			herdrPaneReportAgent({
				paneId: "pane-1",
				source: "factory",
				agent: "factory",
				state: "idle",
				seq: "1",
			}),
			herdrPaneReleaseAgent({ paneId: "pane-1", source: "factory", agent: "factory", seq: "1" }),
			herdrWorktreeList("/repo"),
			herdrWorktreeOpen("/repo", { branch: "factory/1" }),
			herdrWorktreeCreate("/repo", "factory/1"),
			herdrWorktreeRemove("ws-1"),
		];
		for (const invocation of invocations) {
			expect(invocation.command).toBe(HERDR_COMMAND);
		}
	});

	test("the agent command shapes", () => {
		expect(herdrAgentList().args).toEqual(["agent", "list"]);
		expect(herdrAgentStart("worker-1", "pi", "pane-1").args).toEqual([
			"agent",
			"start",
			"worker-1",
			"--kind",
			"pi",
			"--pane",
			"pane-1",
		]);
		// The Agent runtime's own argv rides after the separator, and only when
		// it is non-empty.
		expect(herdrAgentStart("worker-1", "pi", "pane-1", ["--model", "gpt"]).args).toEqual([
			"agent",
			"start",
			"worker-1",
			"--kind",
			"pi",
			"--pane",
			"pane-1",
			"--",
			"--model",
			"gpt",
		]);
		expect(herdrAgentPrompt("worker-1", "go").args).toEqual(["agent", "prompt", "worker-1", "go"]);
		expect(herdrAgentWait("worker-1").args).toEqual([
			"agent",
			"wait",
			"worker-1",
			...HERDR_AGENT_WAIT_UNTIL.flatMap((until) => ["--until", until]),
		]);
		expect(herdrAgentRead("pane-1", 50, "visible", "ansi").args).toEqual([
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
		expect(herdrAgentFocus("pane-1").args).toEqual(["agent", "focus", "pane-1"]);
	});

	test("the workspace command shapes", () => {
		expect(herdrWorkspaceList().args).toEqual(["workspace", "list"]);
		expect(herdrWorkspaceGet("ws-1").args).toEqual(["workspace", "get", "ws-1"]);
		expect(herdrWorkspaceCreate("/repo").args).toEqual([
			"workspace",
			"create",
			"--cwd",
			"/repo",
			"--no-focus",
		]);
		expect(herdrWorkspaceClose("ws-1").args).toEqual(["workspace", "close", "ws-1"]);
	});

	test("the tab command shapes", () => {
		expect(herdrTabCreate("ws-1", "/repo").args).toEqual([
			"tab",
			"create",
			"--workspace",
			"ws-1",
			"--cwd",
			"/repo",
			"--no-focus",
		]);
		// A tab with no checkout stands at the workspace's own directory.
		expect(herdrTabCreate("ws-1", null).args).toEqual([
			"tab",
			"create",
			"--workspace",
			"ws-1",
			"--no-focus",
		]);
		expect(herdrTabList("ws-1").args).toEqual(["tab", "list", "--workspace", "ws-1"]);
		expect(herdrTabClose("tab-1").args).toEqual(["tab", "close", "tab-1"]);
	});

	test("the pane command shapes", () => {
		expect(herdrPaneList("ws-1").args).toEqual(["pane", "list", "--workspace", "ws-1"]);
		expect(herdrPaneClose("pane-1").args).toEqual(["pane", "close", "pane-1"]);
		expect(herdrPaneSendKeys("pane-1", "enter").args).toEqual([
			"pane",
			"send-keys",
			"pane-1",
			"enter",
		]);
		expect(herdrPaneSendText("pane-1", "hello").args).toEqual([
			"pane",
			"send-text",
			"pane-1",
			"hello",
		]);
		expect(
			herdrPaneReportAgent({
				paneId: "pane-1",
				source: "factory",
				agent: "factory",
				state: "idle",
				seq: "42",
			}).args,
		).toEqual([
			"pane",
			"report-agent",
			"pane-1",
			"--source",
			"factory",
			"--agent",
			"factory",
			"--state",
			"idle",
			"--seq",
			"42",
		]);
		expect(
			herdrPaneReleaseAgent({ paneId: "pane-1", source: "factory", agent: "factory", seq: "43" })
				.args,
		).toEqual([
			"pane",
			"release-agent",
			"pane-1",
			"--source",
			"factory",
			"--agent",
			"factory",
			"--seq",
			"43",
		]);
	});

	test("the worktree command shapes", () => {
		expect(herdrWorktreeList("/repo").args).toEqual(["worktree", "list", "--cwd", "/repo"]);
		expect(herdrWorktreeOpen("/repo", { branch: "factory/1" }).args).toEqual([
			"worktree",
			"open",
			"--cwd",
			"/repo",
			"--branch",
			"factory/1",
			"--no-focus",
		]);
		expect(herdrWorktreeOpen("/repo", { path: "/wt" }).args).toEqual([
			"worktree",
			"open",
			"--cwd",
			"/repo",
			"--path",
			"/wt",
			"--no-focus",
		]);
		expect(herdrWorktreeCreate("/repo", "factory/1").args).toEqual([
			"worktree",
			"create",
			"--cwd",
			"/repo",
			"--branch",
			"factory/1",
			"--no-focus",
		]);
		expect(herdrWorktreeCreate("/repo", "factory/1", "origin/main").args).toEqual([
			"worktree",
			"create",
			"--cwd",
			"/repo",
			"--branch",
			"factory/1",
			"--base",
			"origin/main",
			"--no-focus",
		]);
		expect(herdrWorktreeRemove("ws-1").args).toEqual(["worktree", "remove", "--workspace", "ws-1"]);
		expect(herdrWorktreeRemove("ws-1", true).args).toEqual([
			"worktree",
			"remove",
			"--workspace",
			"ws-1",
			"--force",
		]);
	});
});

// ---------------------------------------------------------------------------
// The herdr-core dialect: the argv shapes the module answers
// ---------------------------------------------------------------------------

describe("the herdr-core dialect answers the argv the plane would build", () => {
	test("the host command word is the first field of every invocation", () => {
		const invocations: HostInvocation[] = [
			herdrCoreRun({ name: "worker-1", cwd: "/repo", argv: ["pi"] }),
			herdrCoreSend("t1", "go"),
			herdrCoreList(),
			herdrCoreGet("t1"),
			herdrCoreWait("t1"),
			herdrCoreRead("t1", 50),
			herdrCoreKill("t1"),
			herdrCoreRemove("t1"),
		];
		for (const invocation of invocations) {
			expect(invocation.command).toBe(HERDR_CORE_COMMAND);
		}
	});

	test("the run shape carries the flags the host stands on", () => {
		expect(
			herdrCoreRun({
				name: "worker-1",
				cwd: "/repo",
				argv: ["pi", "--model", "gpt"],
				labels: ["factory.run=probe", "factory.ticket=t-1"],
			}).args,
		).toEqual([
			"run",
			"--bg",
			"--outlive-parent",
			"--no-notify",
			"--name",
			"worker-1",
			"--cwd",
			"/repo",
			"--label",
			"factory.run=probe",
			"--label",
			"factory.ticket=t-1",
			"--",
			"pi",
			"--model",
			"gpt",
		]);
	});

	test("the remaining command shapes", () => {
		expect(herdrCoreSend("t1", "go").args).toEqual(["send", "--json", "t1", "go"]);
		expect(herdrCoreSend("t1", "go", "idle").args).toEqual([
			"send",
			"--json",
			"--if",
			"idle",
			"t1",
			"go",
		]);
		expect(herdrCoreList().args).toEqual(["ls", "--json"]);
		expect(herdrCoreList({ all: true }).args).toEqual(["ls", "--json", "--all"]);
		expect(herdrCoreGet("t1").args).toEqual(["get", "--json", "t1"]);
		expect(herdrCoreWait("t1").args).toEqual(["wait", "--json", "t1"]);
		expect(herdrCoreWait("t1", 120).args).toEqual(["wait", "--json", "--timeout", "120", "t1"]);
		expect(herdrCoreRead("t1", 50).args).toEqual(["read", "--json", "--lines", "50", "t1"]);
		expect(herdrCoreKill("t1").args).toEqual(["kill", "--json", "t1"]);
		expect(herdrCoreRemove("t1").args).toEqual(["rm", "--json", "t1"]);
	});
});

// ---------------------------------------------------------------------------
// The herdr answer readers
// ---------------------------------------------------------------------------

describe("the herdr answer readers", () => {
	test("the error code a failed call carries", () => {
		expect(herdrErrorCode(herdrRefusal("agent_pane_busy"))).toBe("agent_pane_busy");
		// A success carries no code, and a failure herdr did not write as JSON
		// keeps no code.
		expect(herdrErrorCode({ code: 0, stdout: "", stderr: "" })).toBeNull();
		expect(herdrErrorCode({ code: 1, stdout: "", stderr: "no json" })).toBeNull();
	});

	test("the failure line names the message and the code", () => {
		expect(
			herdrFailureText({
				code: 1,
				stdout: "",
				stderr: JSON.stringify({
					error: { code: "agent_name_taken", message: "the name is held" },
				}),
			}),
		).toBe("the name is held (agent_name_taken)");
		// A failure without a JSON answer keeps its raw line.
		expect(herdrFailureText({ code: 127, stdout: "", stderr: "herdr not found in PATH" })).toBe(
			"herdr not found in PATH",
		);
	});

	test("the create handles one answer names", () => {
		const answer: CommandResult = {
			code: 0,
			stdout: JSON.stringify({
				result: {
					workspace: { workspace_id: "ws-1" },
					root_pane: { pane_id: "pane-1" },
					tab: { tab_id: "tab-1" },
				},
			}),
			stderr: "",
		};
		expect(herdrHandles(answer)).toEqual({
			workspaceId: "ws-1",
			paneId: "pane-1",
			tabId: "tab-1",
		});
		expect(jsonResultField(answer, "workspace", "workspace_id")).toBe("ws-1");
	});

	test("a worktree open answers already open", () => {
		expect(
			worktreeAlreadyOpen({
				code: 0,
				stdout: JSON.stringify({ result: { already_open: true } }),
				stderr: "",
			}),
		).toBe(true);
		expect(
			worktreeAlreadyOpen({
				code: 0,
				stdout: JSON.stringify({ result: { already_open: false } }),
				stderr: "",
			}),
		).toBe(false);
	});

	test("the holders a taken-name refusal names", () => {
		const holders = herdrNameHolders({
			code: 1,
			stdout: "",
			stderr:
				"the name is held; candidates: terminal_id=t1 pane_id=pane-1 workspace_id=ws-1 tab_id=tab-1 cwd=/x status=idle",
		});
		expect(holders).toEqual([
			{ terminalId: "t1", paneId: "pane-1", workspaceId: "ws-1", tabId: "tab-1" },
		]);
		expect(
			herdrNameHolders({ code: 1, stdout: "", stderr: "the name is held, no candidates named" }),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The herdr-core answer readers
// ---------------------------------------------------------------------------

/** One live terminal record, the shape an `hc get` answer carries. */
function coreRecord(fields: Partial<Record<string, unknown>> = {}): CommandResult {
	return {
		code: 0,
		stdout: JSON.stringify({
			address: "t1",
			name: "worker-1",
			state: "live",
			status: null,
			cwd: "/repo",
			turn: 0,
			labels: {},
			...fields,
		}),
		stderr: "",
	};
}

describe("the herdr-core answer readers", () => {
	test("the error kind a failed call carries", () => {
		expect(herdrCoreErrorKind(herdrCoreRefusal("name_taken"))).toBe("name_taken");
		expect(herdrCoreErrorKind({ code: 0, stdout: "", stderr: "" })).toBeNull();
		expect(herdrCoreErrorKind({ code: 1, stdout: "", stderr: "no json" })).toBeNull();
	});

	test("the failure line names the message and the kind", () => {
		expect(
			herdrCoreFailureText({
				code: 11,
				stdout: "",
				stderr: JSON.stringify({ error: { kind: "finished", message: "t1 has finished" } }),
			}),
		).toBe("t1 has finished (finished)");
	});

	test("the roster reads live and finished terminals, with no status word", () => {
		const roster = herdrCoreRoster({
			code: 0,
			stdout: JSON.stringify({
				hidden_finished: 0,
				terminals: [
					{ address: "t1", name: "a", state: "live", agent: "pi", cwd: "/repo", turn: 3 },
					{ address: "t2", name: "b", state: "finished", reason: "killed", signal: 1 },
				],
			}),
			stderr: "",
		});
		expect(roster).toEqual([
			{ address: "t1", name: "a", state: "live", agent: "pi", cwd: "/repo", turn: 3 },
			{ address: "t2", name: "b", state: "finished", reason: "killed", signal: 1 },
		]);
		// A roster the host did not write as a terminal list reads as absent.
		expect(herdrCoreRoster({ code: 0, stdout: '{"no":true}', stderr: "" })).toBeNull();
	});

	test("the record reads the terminal's state and its status through the map", () => {
		expect(
			herdrCoreRecord(
				coreRecord({ status: "working", state: "live", labels: { "factory.run": "probe" } }),
			),
		).toEqual({
			address: "t1",
			name: "worker-1",
			state: "live",
			status: "working",
			turn: 0,
			cwd: "/repo",
			labels: { "factory.run": "probe" },
		});
		// A program that reports no status reads as unknown, and a finished
		// terminal carries its settle facts.
		const finished = herdrCoreRecord(
			coreRecord({ state: "finished", status: null, reason: "exit", exit_code: 0 }),
		);
		expect(finished?.state).toBe("finished");
		expect(finished?.status).toBe("unknown");
		expect(finished?.reason).toBe("exit");
		expect(finished?.exitCode).toBe(0);
		// A record the host did not write with its required fields reads as absent.
		expect(herdrCoreRecord({ code: 0, stdout: '{"address":"t1"}', stderr: "" })).toBeNull();
	});
});
