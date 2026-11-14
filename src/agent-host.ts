/**
 * The Agent host (issue #407, ADR 0141): the one module the plane's Agent host
 * dialects live in.
 *
 * The plane drives two Agent hosts, `herdr` and `herdr-core`. This module owns
 * the three host facts the surfaces may not bypass:
 *
 * - the command dialects: every `herdr` and `herdr-core` argv the plane builds
 *   is built here. A surface names the action, and the module answers with the
 *   command word and its argv.
 * - the host word map: the host state words and refusal codes become the
 *   plane's named facts in one table, so a host rename is a change to this
 *   table, not a search-and-replace across the surfaces.
 * - the host resolution: the operator's config, then the environment mark,
 *   then the default. The boot calls it once with the config's value or
 *   nothing and the marks it read once (issue #408), and the boot statement
 *   the module owns states the answer beside the fact that resolved it.
 *
 * This module is not a command runner: the Command runner seam (src/runner.ts)
 * is still the plane's only egress to the outside world. The module builds
 * argv and reads answers; it sends nothing.
 *
 * Step 1 of issue #407 stands the module up and moves the existing `herdr`
 * dialect through it. The `herdr-core` dialect stands in the module and in the
 * Stub herdr world (ADR 0132) without a product-side caller: the plane sends
 * no `herdr-core` command until the later flows land.
 *
 * The answer shapes the readers trace to the recorded probes in
 * docs/verification/agent-host-herdr-core.md. A shape the probes could not
 * measure stands unverified there.
 */

import { failureLine } from "./lines.ts";
import type { CommandResult } from "./runner.ts";
import { commandFailureText } from "./runner.ts";

/** The Agent host the plane can resolve to. */
export type AgentHost = "herdr" | "herdr-core";

/**
 * The two Agent hosts a start can take (issue #409), in the order the
 * Consultation launcher and the override panel offer them on their host rows.
 */
export const AGENT_HOSTS: readonly AgentHost[] = ["herdr", "herdr-core"];

/** The command word of the herdr host. */
export const HERDR_COMMAND = "herdr";

/**
 * The command word of the herdr-core host. The host's name is the full
 * `herdr-core`; `hc` is the word the command line spells.
 */
export const HERDR_CORE_COMMAND = "hc";

/** The command word of the host: the first field of an invocation. */
export function hostCommand(host: AgentHost): string {
	return host === "herdr" ? HERDR_COMMAND : HERDR_CORE_COMMAND;
}

/**
 * One command the plane asks a host to run: the command word and its argv.
 * The module builds it, and the surface hands it to the Command runner seam.
 * The argv is immutable.
 */
export interface HostInvocation {
	readonly command: string;
	readonly args: readonly string[];
}

// ---------------------------------------------------------------------------
// The host word map
// ---------------------------------------------------------------------------

/** The status the plane holds for an Agent, in its own words. */
export type AgentStatus = "working" | "done" | "idle" | "blocked" | "unknown";

/**
 * The named fact a host refusal names for the plane. A word the table does not
 * name reads as `other`: the failure keeps its message, and the plane's
 * word-driven rules simply do not fire on it.
 */
export type RefusalFact =
	| "agent_name_taken"
	| "agent_pane_busy"
	| "workspace_not_found"
	| "tab_not_found"
	| "worktree_not_found"
	| "worktree_remove_failed"
	| "terminal_not_found"
	| "terminal_finished"
	| "terminal_live"
	| "terminal_blocked"
	| "other";

/**
 * The host word map: one row per word a host reports - a state word or a
 * refusal code - and the named plane fact the word becomes. A host rename is
 * a change to this table, not a search-and-replace across the surfaces.
 *
 * The status words are one shared set: both hosts report the same words
 * because both read the program's OSC 7501 reports (ADR 0141), so a status
 * row names no host. A refusal row names its host, because the hosts refuse
 * differently: herdr answers `agent_name_taken` where herdr-core answers
 * `name_taken`.
 *
 * The refusal words are the codes herdr 0.9.5 answers and the kinds hc 0.1.20
 * answers, as the plane reads them. A word the table has not measured yet
 * stands in the verification record, unverified.
 */
export type HostWordRow =
	| { word: string; status: AgentStatus }
	| { host: AgentHost; word: string; fact: RefusalFact };

/**
 * The host word map, as one table (issue #407): each row is a word a host
 * reports and the plane fact it answers, so the suite can walk it and a host
 * rename is an edit to this table, not to the surfaces. A status row names no
 * host; a refusal row names the host that answers the word.
 */
export const HOST_WORD_TABLE: readonly HostWordRow[] = [
	// The status words: the set both hosts report. `error` is a word the
	// program reports, and the plane's status words hold no error fact, so it
	// reads as `unknown` the way every word the table does not name does.
	{ word: "working", status: "working" },
	{ word: "idle", status: "idle" },
	{ word: "done", status: "done" },
	{ word: "blocked", status: "blocked" },
	{ word: "error", status: "unknown" },
	// The herdr refusal codes.
	{ host: "herdr", word: "agent_name_taken", fact: "agent_name_taken" },
	{ host: "herdr", word: "agent_pane_busy", fact: "agent_pane_busy" },
	{ host: "herdr", word: "workspace_not_found", fact: "workspace_not_found" },
	{ host: "herdr", word: "tab_not_found", fact: "tab_not_found" },
	{ host: "herdr", word: "worktree_not_found", fact: "worktree_not_found" },
	{ host: "herdr", word: "worktree_remove_failed", fact: "worktree_remove_failed" },
	// The herdr-core refusal kinds, as hc 0.1.20 answers them.
	{ host: "herdr-core", word: "name_taken", fact: "agent_name_taken" },
	{ host: "herdr-core", word: "not_found", fact: "terminal_not_found" },
	{ host: "herdr-core", word: "finished", fact: "terminal_finished" },
	{ host: "herdr-core", word: "live", fact: "terminal_live" },
	{ host: "herdr-core", word: "blocked", fact: "terminal_blocked" },
	{ host: "herdr-core", word: "status_mismatch", fact: "other" },
	{ host: "herdr-core", word: "spawn_failed", fact: "other" },
];

/**
 * The status a host word reports, in the plane's own words. A word the table
 * does not name reads as `unknown`, the plane's standing word for a status it
 * cannot read.
 */
export function normalizeAgentStatus(raw: string): AgentStatus {
	const word = raw.trim().toLowerCase();
	for (const row of HOST_WORD_TABLE) {
		if ("status" in row && row.word === word) return row.status;
	}
	return "unknown";
}

/** The named plane fact a host refusal word names, when the table names one. */
function refusalFact(host: AgentHost, word: string): RefusalFact {
	for (const row of HOST_WORD_TABLE) {
		if ("fact" in row && row.host === host && row.word === word) return row.fact;
	}
	return "other";
}

// ---------------------------------------------------------------------------
// The herdr dialect
// ---------------------------------------------------------------------------

/**
 * The settle states the wake wait waits for (ADR 0084): the set the plane
 * pins rather than leaving to herdr's default, so a herdr version that changes
 * its default cannot change the plane's wake standing.
 */
export const HERDR_AGENT_WAIT_UNTIL = ["idle", "done", "blocked"] as const;

/** List the agents herdr holds, one row per live Agent. */
export function herdrAgentList(): HostInvocation {
	return { command: HERDR_COMMAND, args: ["agent", "list"] };
}

/**
 * Start an Agent in a pane under a name. `runtimeArgs` is the Agent runtime's
 * own argv; herdr answers it after the `--` separator the invocation carries
 * when the list is non-empty.
 */
export function herdrAgentStart(
	name: string,
	kind: string,
	paneId: string,
	runtimeArgs: readonly string[] = [],
): HostInvocation {
	const args = ["agent", "start", name, "--kind", kind, "--pane", paneId];
	if (runtimeArgs.length > 0) args.push("--", ...runtimeArgs);
	return { command: HERDR_COMMAND, args };
}

/** Prompt a running Agent under its name. */
export function herdrAgentPrompt(name: string, prompt: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["agent", "prompt", name, prompt] };
}

/**
 * The wake wait: block until the Agent reaches one of the pinned settle
 * states. The until set is the plane's, not herdr's default.
 */
export function herdrAgentWait(target: string): HostInvocation {
	const args = ["agent", "wait", target];
	for (const until of HERDR_AGENT_WAIT_UNTIL) args.push("--until", until);
	return { command: HERDR_COMMAND, args };
}

/** Read a pane's output, in the source and format the surface names. */
export function herdrAgentRead(
	paneId: string,
	lines: number,
	source: "visible" | "recent-unwrapped",
	format: "text" | "ansi",
): HostInvocation {
	return {
		command: HERDR_COMMAND,
		args: [
			"agent",
			"read",
			paneId,
			"--lines",
			String(lines),
			"--source",
			source,
			"--format",
			format,
		],
	};
}

/** The one focus move the plane makes: Goto, at the operator's key (ADR 0061). */
export function herdrAgentFocus(paneId: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["agent", "focus", paneId] };
}

/** List the workspaces herdr holds. */
export function herdrWorkspaceList(): HostInvocation {
	return { command: HERDR_COMMAND, args: ["workspace", "list"] };
}

/** Read one workspace. */
export function herdrWorkspaceGet(workspaceId: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["workspace", "get", workspaceId] };
}

/** Create a workspace at a checkout. */
export function herdrWorkspaceCreate(checkout: string): HostInvocation {
	return {
		command: HERDR_COMMAND,
		args: ["workspace", "create", "--cwd", checkout, "--no-focus"],
	};
}

/** Close a workspace. */
export function herdrWorkspaceClose(workspaceId: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["workspace", "close", workspaceId] };
}

/**
 * Create a tab in a workspace. `cwd` names the checkout the tab stands in; a
 * null cwd leaves the tab at the workspace's own directory.
 */
export function herdrTabCreate(workspaceId: string, cwd: string | null): HostInvocation {
	const args = ["tab", "create", "--workspace", workspaceId];
	if (cwd !== null) args.push("--cwd", cwd);
	args.push("--no-focus");
	return { command: HERDR_COMMAND, args };
}

/** List a workspace's tabs. */
export function herdrTabList(workspaceId: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["tab", "list", "--workspace", workspaceId] };
}

/** Close a tab. */
export function herdrTabClose(tabId: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["tab", "close", tabId] };
}

/** List a workspace's panes. */
export function herdrPaneList(workspaceId: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["pane", "list", "--workspace", workspaceId] };
}

/** Close a pane. */
export function herdrPaneClose(paneId: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["pane", "close", paneId] };
}

/** Send one semantic key to a pane. */
export function herdrPaneSendKeys(paneId: string, key: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["pane", "send-keys", paneId, key] };
}

/** Send one text chunk to a pane. */
export function herdrPaneSendText(paneId: string, text: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["pane", "send-text", paneId, text] };
}

/**
 * The plane's own face in a herdr pane (ADR 0139): report the pane's Agent as
 * the plane, so herdr reads the process's own report instead of its own
 * detector. The source and agent names are the plane's identity, so the caller
 * supplies them; the module owns the argv shape.
 */
export function herdrPaneReportAgent(fields: {
	paneId: string;
	source: string;
	agent: string;
	state: string;
	seq: string;
}): HostInvocation {
	return {
		command: HERDR_COMMAND,
		args: [
			"pane",
			"report-agent",
			fields.paneId,
			"--source",
			fields.source,
			"--agent",
			fields.agent,
			"--state",
			fields.state,
			"--seq",
			fields.seq,
		],
	};
}

/** Give a reported pane back to herdr when the run ends. */
export function herdrPaneReleaseAgent(fields: {
	paneId: string;
	source: string;
	agent: string;
	seq: string;
}): HostInvocation {
	return {
		command: HERDR_COMMAND,
		args: [
			"pane",
			"release-agent",
			fields.paneId,
			"--source",
			fields.source,
			"--agent",
			fields.agent,
			"--seq",
			fields.seq,
		],
	};
}

/** List the worktrees git holds at a checkout. */
export function herdrWorktreeList(checkout: string): HostInvocation {
	return { command: HERDR_COMMAND, args: ["worktree", "list", "--cwd", checkout] };
}

/**
 * Open the worktree that stands on a branch, or - when git no longer records
 * it under the branch - the worktree at a path.
 */
export function herdrWorktreeOpen(
	checkout: string,
	locate: { branch: string } | { path: string },
): HostInvocation {
	const key = "branch" in locate ? "--branch" : "--path";
	const value = "branch" in locate ? locate.branch : locate.path;
	return {
		command: HERDR_COMMAND,
		args: ["worktree", "open", "--cwd", checkout, key, value, "--no-focus"],
	};
}

/**
 * Create a worktree on a branch, on the base the start names when it names
 * one.
 */
export function herdrWorktreeCreate(
	checkout: string,
	branch: string,
	base?: string,
): HostInvocation {
	const args = ["worktree", "create", "--cwd", checkout, "--branch", branch];
	if (base !== undefined) args.push("--base", base);
	args.push("--no-focus");
	return { command: HERDR_COMMAND, args };
}

/**
 * Remove a worktree through herdr's workspace. `force` removes a dirty
 * checkout and kills the workspace's Agents.
 */
export function herdrWorktreeRemove(workspaceId: string, force = false): HostInvocation {
	const args = ["worktree", "remove", "--workspace", workspaceId];
	if (force) args.push("--force");
	return { command: HERDR_COMMAND, args };
}

// ---------------------------------------------------------------------------
// The herdr-core dialect
// ---------------------------------------------------------------------------

/**
 * Start an Agent terminal. The flags ADR 0141 fixes land on the record: the
 * terminal stands in the background, outlives its parent's program, and takes
 * no parent notes. `labels` are the `key=value` pairs the plane reads back
 * from the record.
 */
export function herdrCoreRun(fields: {
	name: string;
	cwd: string;
	/** The Agent program and its arguments, after the `--` separator. */
	argv: readonly string[];
	labels?: readonly string[];
}): HostInvocation {
	const args = [
		"run",
		"--bg",
		"--outlive-parent",
		"--no-notify",
		"--name",
		fields.name,
		"--cwd",
		fields.cwd,
	];
	for (const label of fields.labels ?? []) args.push("--label", label);
	args.push("--", ...fields.argv);
	return { command: HERDR_CORE_COMMAND, args };
}

/**
 * Paste text into a terminal and press Enter. `guard` types only when the
 * terminal's status is exactly that word: a program that reports no status is
 * not idle, and the send answers its own refusal.
 */
export function herdrCoreSend(
	address: string,
	text: string,
	guard?: "idle" | "working",
): HostInvocation {
	const args = ["send", "--json"];
	if (guard !== undefined) args.push("--if", guard);
	args.push(address, text);
	return { command: HERDR_CORE_COMMAND, args };
}

/**
 * The roster: live terminals, and the finished ones when `all` is set. The
 * roster carries no status word: a terminal's status is read from its record.
 */
export function herdrCoreList(options?: {
	all?: boolean;
	labels?: readonly string[];
}): HostInvocation {
	const args = ["ls", "--json"];
	for (const label of options?.labels ?? []) args.push("--label", label);
	if (options?.all) args.push("--all");
	return { command: HERDR_CORE_COMMAND, args };
}

/** One terminal's full record: the status word lives here, not in the roster. */
export function herdrCoreGet(address: string): HostInvocation {
	return { command: HERDR_CORE_COMMAND, args: ["get", "--json", address] };
}

/**
 * Wait for one terminal. A finished terminal answers at once. A live one
 * holds until the terminal finishes, and `timeoutSeconds` makes the wait check
 * in: the answer reports `ended: false` and the terminal keeps running.
 */
export function herdrCoreWait(address: string, timeoutSeconds?: number): HostInvocation {
	const args = ["wait", "--json"];
	if (timeoutSeconds !== undefined) args.push("--timeout", String(timeoutSeconds));
	args.push(address);
	return { command: HERDR_CORE_COMMAND, args };
}

/** Read a terminal's output, in the last `lines` lines of its history. */
export function herdrCoreRead(address: string, lines: number): HostInvocation {
	return {
		command: HERDR_CORE_COMMAND,
		args: ["read", "--json", "--lines", String(lines), address],
	};
}

/** Kill the terminal's program. A finished terminal answers its record again. */
export function herdrCoreKill(address: string): HostInvocation {
	return { command: HERDR_CORE_COMMAND, args: ["kill", "--json", address] };
}

/** Remove a finished terminal's record. A live one refuses: kill it first. */
export function herdrCoreRemove(address: string): HostInvocation {
	return { command: HERDR_CORE_COMMAND, args: ["rm", "--json", address] };
}

// ---------------------------------------------------------------------------
// The herdr answer readers
// ---------------------------------------------------------------------------

/**
 * The stable error code a failed herdr call carries, if any. Herdr emits its
 * CLI errors as one JSON object on stderr.
 */
export function herdrErrorCode(result: CommandResult): string | null {
	if (result.code === 0) {
		return null;
	}
	let data: unknown;
	try {
		data = JSON.parse(result.stderr);
	} catch {
		return null;
	}
	const code = (data as { error?: { code?: unknown } }).error?.code;
	return typeof code === "string" && code !== "" ? code : null;
}

/**
 * A failed herdr command as one readable line.
 *
 * Herdr's error code rides along: it is the stable part of the answer, and a
 * message can change with the herdr version. A failure herdr did not write as
 * JSON keeps its raw line.
 *
 * The message carries another tool's whole answer when herdr only ran it: a
 * refused `worktree create` holds Git's progress line and its refusal. The
 * plane states the line that names the failure, the way it reads a raw
 * failure; the Message line is one row, so the rest never reaches the operator.
 */
export function herdrFailureText(result: CommandResult): string {
	const code = herdrErrorCode(result);
	if (code === null) {
		return commandFailureText(result);
	}
	const message = herdrErrorMessage(result);
	if (message === "") {
		return code;
	}
	const line = failureLine(message) ?? message.trim();
	return `${line} (${code})`;
}

/** The `error.message` of a herdr JSON error, or "" when it carries none. */
function herdrErrorMessage(result: CommandResult): string {
	let data: unknown;
	try {
		data = JSON.parse(result.stderr);
	} catch {
		return "";
	}
	const message = (data as { error?: { message?: unknown } }).error?.message;
	return typeof message === "string" ? message : "";
}

/** The named plane fact a failed herdr answer's code names, when it names one. */
export function herdrRefusalFact(result: CommandResult): RefusalFact | null {
	const word = herdrErrorCode(result);
	return word === null ? null : refusalFact("herdr", word);
}

/** Read `result.<field>.<key>` out of a herdr JSON answer. */
export function jsonResultField(result: CommandResult, field: string, key: string): string | null {
	if (result.code !== 0) {
		return null;
	}
	let data: unknown;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		return null;
	}
	const value = (data as { result?: Record<string, Record<string, unknown>> }).result?.[field]?.[
		key
	];
	return typeof value === "string" && value !== "" ? value : null;
}

/** True when a `worktree open` answer says a workspace was already open. */
export function worktreeAlreadyOpen(result: CommandResult): boolean {
	let data: unknown;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		return false;
	}
	return (data as { result?: { already_open?: unknown } }).result?.already_open === true;
}

/** One row of herdr's `worktree list` answer, in git's own shape. */
export interface HerdrListedWorktree {
	/** The path of the worktree's checkout. */
	path: string;
	/** Set when a herdr workspace is open on the worktree. */
	open_workspace_id?: string;
}

/**
 * The rows of herdr's `worktree list` answer, or null when the answer does not
 * read (issue #411).
 *
 * herdr's list is git's own record with herdr's fact written beside it: each
 * row keeps the checkout's path, and herdr adds whether a herdr workspace is
 * open on the worktree. The Close guard reads the rows so the plane never
 * removes a checkout a herdr workspace still holds.
 */
export function readHerdrWorktreeList(result: CommandResult): HerdrListedWorktree[] | null {
	if (result.code !== 0) {
		return null;
	}
	let data: unknown;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		return null;
	}
	const worktrees = (data as { result?: { worktrees?: unknown } }).result?.worktrees;
	if (!Array.isArray(worktrees)) return null;
	const rows: HerdrListedWorktree[] = [];
	for (const entry of worktrees) {
		if (typeof entry !== "object" || entry === null) continue;
		const row = entry as { path?: unknown; open_workspace_id?: unknown };
		if (typeof row.path !== "string") continue;
		if (typeof row.open_workspace_id === "string" && row.open_workspace_id !== "") {
			rows.push({ path: row.path, open_workspace_id: row.open_workspace_id });
		} else {
			rows.push({ path: row.path });
		}
	}
	return rows;
}

/**
 * The handles one herdr create answer names (issue #204): the workspace it made
 * or opened, the root pane of that workspace, and the tab that holds it. One
 * reader serves every start site, so a start cannot read one answer three ways.
 */
export function herdrHandles(result: CommandResult): {
	workspaceId: string | null;
	paneId: string | null;
	tabId: string | null;
} {
	return {
		workspaceId: jsonResultField(result, "workspace", "workspace_id"),
		paneId: jsonResultField(result, "root_pane", "pane_id"),
		tabId: jsonResultField(result, "tab", "tab_id"),
	};
}

/**
 * The agents herdr names as the holders of a taken agent name.
 *
 * herdr 0.8.2 writes each candidate into the error message as
 * `terminal_id=.. pane_id=.. workspace_id=.. tab_id=.. cwd=.. status=..`.
 * The identifiers carry no spaces, so the read stops there: a working
 * directory that does is not this reader's problem. A message that names no
 * candidate comes back empty, and the collision is reported without one.
 */
export function herdrNameHolders(result: CommandResult): AgentHolder[] {
	const text = `${result.stderr}\n${result.stdout}`;
	const holders: AgentHolder[] = [];
	for (const match of text.matchAll(
		/terminal_id=(\S+)\s+pane_id=(\S+)\s+workspace_id=(\S+)\s+tab_id=(\S+)/g,
	)) {
		holders.push({
			terminalId: match[1],
			paneId: match[2],
			workspaceId: match[3],
			tabId: match[4],
		});
	}
	return holders;
}

/** One holder herdr names for a taken agent name, as its error message writes it. */
export interface AgentHolder {
	terminalId: string | null;
	paneId: string | null;
	workspaceId: string | null;
	tabId: string | null;
}

/** One live agent a herdr `agent list` answer names by name (ADR 0142). */
export interface HerdrListedAgent {
	name: string;
	paneId: string;
	tabId: string;
	workspaceId: string;
}

/**
 * The live agents one herdr `agent list` answer names by name: the holders a
 * herdr-core start's cross-host name check reads, so one name held on herdr
 * is held for the start on herdr-core alike (ADR 0142). An answer that is not
 * a readable agent list, or an item that names no pane and no agent, comes
 * back absent or unnamed, the way the observation cycle's own read does.
 */
export function herdrListedAgents(result: CommandResult): HerdrListedAgent[] | null {
	if (result.code !== 0) {
		return null;
	}
	let data: unknown;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		return null;
	}
	const result_ = (data as { result?: { agents?: unknown } }).result;
	const raw = Array.isArray(result_?.agents) ? (result_?.agents as unknown[]) : [];
	const listed: HerdrListedAgent[] = [];
	for (const item of raw) {
		const record = item as Record<string, unknown>;
		if (typeof record.pane_id !== "string" || record.pane_id === "") continue;
		if (typeof record.name !== "string" || record.name === "") continue;
		listed.push({
			name: record.name,
			paneId: record.pane_id,
			tabId: typeof record.tab_id === "string" ? record.tab_id : "",
			workspaceId: typeof record.workspace_id === "string" ? record.workspace_id : "",
		});
	}
	return listed;
}

// ---------------------------------------------------------------------------
// The herdr-core answer readers
// ---------------------------------------------------------------------------

/**
 * The stable error kind a failed herdr-core call carries, if any. Hc emits its
 * CLI errors as one JSON object on stderr, the way herdr does.
 */
export function herdrCoreErrorKind(result: CommandResult): string | null {
	if (result.code === 0) {
		return null;
	}
	let data: unknown;
	try {
		data = JSON.parse(result.stderr);
	} catch {
		return null;
	}
	const kind = (data as { error?: { kind?: unknown } }).error?.kind;
	return typeof kind === "string" && kind !== "" ? kind : null;
}

/**
 * A failed herdr-core command as one readable line.
 *
 * The error kind rides along beside the message: it is the stable part of the
 * answer, and a message can change with the hc version. A failure hc did not
 * write as JSON keeps its raw line.
 */
export function herdrCoreFailureText(result: CommandResult): string {
	const kind = herdrCoreErrorKind(result);
	if (kind === null) {
		return commandFailureText(result);
	}
	const message = herdrCoreErrorMessage(result);
	if (message === "") {
		return kind;
	}
	const line = failureLine(message) ?? message.trim();
	return `${line} (${kind})`;
}

/** The `error.message` of an hc JSON error, or "" when it carries none. */
function herdrCoreErrorMessage(result: CommandResult): string {
	let data: unknown;
	try {
		data = JSON.parse(result.stderr);
	} catch {
		return "";
	}
	const message = (data as { error?: { message?: unknown } }).error?.message;
	return typeof message === "string" ? message : "";
}

/** The named plane fact a failed hc answer's kind names, when it names one. */
export function herdrCoreRefusalFact(result: CommandResult): RefusalFact | null {
	const word = herdrCoreErrorKind(result);
	return word === null ? null : refusalFact("herdr-core", word);
}

/** One terminal row of an `hc ls` answer, as the roster writes it. */
export interface HerdrCoreRosterRow {
	address: string;
	name: string;
	state: "live" | "finished";
	agent?: string;
	cwd?: string;
	turn?: number;
	reason?: string;
	signal?: number;
}

/**
 * The terminals of an `hc ls` answer, in the order the host lists them. The
 * roster carries no status word: a terminal's status is read from its record.
 * A null answer means the result is not a readable roster.
 */
export function herdrCoreRoster(result: CommandResult): HerdrCoreRosterRow[] | null {
	if (result.code !== 0) {
		return null;
	}
	let data: unknown;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		return null;
	}
	const rows = (data as { terminals?: unknown }).terminals;
	if (!Array.isArray(rows)) return null;
	const out: HerdrCoreRosterRow[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const parsed = rosterRowOf(row as Record<string, unknown>);
		if (parsed !== null) out.push(parsed);
	}
	return out;
}

/**
 * One terminal row of an `hc ls` answer, in the order the host lists them. A
 * row the host did not write with its three required fields reads as absent,
 * and the roster keeps the rows it can read. The roster carries no status
 * word: a terminal's status is read from its record.
 */
function rosterRowOf(item: Record<string, unknown>): HerdrCoreRosterRow | null {
	if (
		typeof item.address !== "string" ||
		typeof item.name !== "string" ||
		typeof item.state !== "string"
	) {
		return null;
	}
	return {
		address: item.address,
		name: item.name,
		state: item.state === "live" ? "live" : "finished",
		agent: recordString(item, "agent"),
		cwd: recordString(item, "cwd"),
		turn: recordNumber(item, "turn"),
		reason: recordString(item, "reason"),
		signal: recordNumber(item, "signal"),
	};
}

/** One terminal's record of an `hc get` answer, read through the host word map. */
export interface HerdrCoreRecord {
	address: string;
	/**
	 * The name the terminal holds. The desktop creates its terminals without
	 * a name, and their records name null (ADR 0141).
	 */
	name: string | null;
	state: "live" | "finished";
	/** The status in the plane's words: a program that reports no status reads as `unknown`. */
	status: AgentStatus;
	turn?: number;
	reason?: string;
	exitCode?: number;
	signal?: number;
	cwd?: string;
	labels?: Record<string, string>;
}

/**
 * The status word of an `hc` record, in either shape the host writes it: the
 * word alone, or the reporting program's word beside its name. A value the
 * host writes in no shape it reads - or a shape whose word is not a string -
 * reads as absent.
 */
function recordStatusWord(item: Record<string, unknown>): string | undefined {
	const value = item.status;
	if (typeof value === "string") return value;
	if (typeof value === "object" && value !== null) {
		const state = (value as Record<string, unknown>).state;
		if (typeof state === "string") return state;
	}
	return undefined;
}

/** Read one string field of an `hc` record; a value the host did not write as a string reads as absent. */
function recordString(item: Record<string, unknown>, key: string): string | undefined {
	const value = item[key];
	return typeof value === "string" ? value : undefined;
}

/** Read one number field of an `hc` record; a value the host did not write as a number reads as absent. */
function recordNumber(item: Record<string, unknown>, key: string): number | undefined {
	const value = item[key];
	return typeof value === "number" ? value : undefined;
}

/** The label map of an `hc` record, keeping the string values; absent when the record carries no labels. */
function recordLabels(item: Record<string, unknown>): Record<string, string> | undefined {
	const raw = item.labels;
	if (typeof raw !== "object" || raw === null) return undefined;
	return Object.fromEntries(
		Object.entries(raw as Record<string, unknown>).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

/**
 * The record an `hc get` answer carries: the terminal's state, its status
 * read through the host word map, and the settle facts of a finished
 * terminal. A null answer means the result is not a readable record.
 */
export function herdrCoreRecord(result: CommandResult): HerdrCoreRecord | null {
	if (result.code !== 0) {
		return null;
	}
	let data: unknown;
	try {
		data = JSON.parse(result.stdout);
	} catch {
		return null;
	}
	const item = data as Record<string, unknown>;
	if (
		typeof item.address !== "string" ||
		(item.name !== null && typeof item.name !== "string") ||
		typeof item.state !== "string"
	) {
		return null;
	}
	return {
		address: item.address,
		name: item.name === null ? null : item.name,
		state: item.state === "live" ? "live" : "finished",
		status: normalizeAgentStatus(recordStatusWord(item) ?? ""),
		turn: recordNumber(item, "turn"),
		reason: recordString(item, "reason"),
		exitCode: recordNumber(item, "exit_code"),
		signal: recordNumber(item, "signal"),
		cwd: recordString(item, "cwd"),
		labels: recordLabels(item),
	};
}

// ---------------------------------------------------------------------------
// The start's labels
// ---------------------------------------------------------------------------

/**
 * The label namespace the plane writes at the start of every herdr-core
 * terminal it starts (ADR 0141, ADR 0148).
 *
 * The plane's own namespace carries the run, the Ticket, the Handoff, and the
 * repository, which is what scopes the roster read and keeps a dead run's rows
 * readable. Beside those the plane copies the space Adoption label
 * `herdr.space` from its own herdr-core terminal when that terminal carries
 * it, and writes no such label when it does not. It copies no tab label:
 * with one the desktop splits the terminal into that tab beside the plane,
 * and with the space label alone the desktop gives the terminal its own tab
 * in that space (ADR 0148). The labels are written at the start and never
 * rewritten by a later command, and a roster read is scoped by them only for
 * forensics, never to hide the other host (ADR 0142).
 */
export const CORE_START_LABEL_RUN = "factory.run";
export const CORE_START_LABEL_TICKET = "factory.ticket";
export const CORE_START_LABEL_HANDOFF = "factory.handoff";
export const CORE_START_LABEL_REPOSITORY = "factory.repository";
/** The Adoption label the desktop writes on a terminal it adopts into a space. */
export const CORE_ADOPTION_LABEL_SPACE = "herdr.space";

/** The run's own identity facts, the ones the start's labels name. */
export interface CoreStartLabelFacts {
	/** The run the start stands in: the terminal or pane its operator stands in. */
	runIdentity: string;
	/** The work the start runs: the Ticket's identity, or the Consultation's on a Consultation start. */
	ticketIdentity: string;
	/** The repository the start resolved to. */
	repositoryIdentity: string;
}

/**
 * The labels the plane writes at the start of one herdr-core terminal (ADR
 * 0141): its own namespace - the run, the Ticket, the Handoff, the
 * repository - beside the Adoption labels the plane's own terminal carries.
 * The Handoff label is the terminal name the start takes: the roster that
 * scopes by it finds the Handoff's terminal, and the finished record the
 * residue record and the operator's Close act on keeps it until `hc rm`.
 */
export function herdrCoreStartLabels(
	facts: CoreStartLabelFacts,
	terminalName: string,
	adoption: Record<string, string>,
): string[] {
	const labels = [
		`${CORE_START_LABEL_RUN}=${facts.runIdentity}`,
		`${CORE_START_LABEL_TICKET}=${facts.ticketIdentity}`,
		`${CORE_START_LABEL_HANDOFF}=${terminalName}`,
		`${CORE_START_LABEL_REPOSITORY}=${facts.repositoryIdentity}`,
	];
	for (const [key, value] of Object.entries(adoption)) labels.push(`${key}=${value}`);
	return labels;
}

// ---------------------------------------------------------------------------
// The host resolution
// ---------------------------------------------------------------------------

/** The fact that settled the host: what the run states beside the host it resolved. */
export type AgentHostFact = "config" | "herdr-mark" | "herdr-core-mark" | "default";

/**
 * The identity the start's labels write under the run key (ADR 0141): the
 * terminal the run stands in on herdr-core, the pane its operator stands in
 * inside herdr, and the name an unmarked run takes when it marks neither.
 */
export function runIdentityOf(marks: AgentHostMarks): string {
	return marks.hcTerminalId ?? marks.herdrEnv ?? "standalone";
}

/** The host a start resolves, and the fact that resolved it. */
export interface AgentHostResolution {
	readonly host: AgentHost;
	readonly fact: AgentHostFact;
}

/** The environment marks the resolution reads. */
export interface AgentHostMarks {
	/** The in-herdr mark (ADR 0024): any non-empty value names the herdr host. */
	herdrEnv: string | undefined;
	/** The herdr-core terminal id the plane's process stands in, when it does. */
	hcTerminalId: string | undefined;
}

/**
 * Resolve the plane's Agent host (ADR 0141): the operator's config first, then
 * the environment mark, then the default.
 *
 * The config rule validates the key before the value reaches this function: a
 * value outside the two host names is a boot refusal, so the resolution
 * answers only a host name or no key at all. With both marks standing, the
 * herdr mark wins: the plane stands in one place, and the ADR names the herdr
 * mark first.
 */
export function resolveAgentHost(
	configHost: string | undefined,
	marks: AgentHostMarks,
): AgentHostResolution {
	if (configHost === "herdr" || configHost === "herdr-core") {
		return { host: configHost, fact: "config" };
	}
	if (marks.herdrEnv !== undefined && marks.herdrEnv !== "") {
		return { host: "herdr", fact: "herdr-mark" };
	}
	if (marks.hcTerminalId !== undefined && marks.hcTerminalId !== "") {
		return { host: "herdr-core", fact: "herdr-core-mark" };
	}
	return { host: "herdr-core", fact: "default" };
}

// ---------------------------------------------------------------------------
// The boot statement and the version floor
// ---------------------------------------------------------------------------

/** The fact word the boot statement names beside the host it resolved. */
const AGENT_HOST_FACT_WORDS: Record<AgentHostFact, string> = {
	config: "the config",
	"herdr-mark": "the herdr mark",
	"herdr-core-mark": "the herdr-core mark",
	default: "the default",
};

/**
 * The boot statement (issue #408, ADR 0141): the one line the boot writes
 * once, on the Message line and in the Plane boot record (ADR 0129). It names
 * the host the boot resolved and the fact that resolved it, and it states the
 * core-start effect the measurement stands on: on Unix no herdr-core read
 * answers without starting the session's core when none runs, so the run
 * states the effect instead of pre-checking it (ADR 0141).
 */
export function agentHostBootLine(resolution: AgentHostResolution): string {
	return (
		`agent host: ${resolution.host} ` +
		`(resolved from ${AGENT_HOST_FACT_WORDS[resolution.fact]}; ` +
		"the first herdr-core read starts that session's core when none runs)"
	);
}

// ---------------------------------------------------------------------------
// Host availability and the lines it states
// ---------------------------------------------------------------------------

/**
 * Whether the run's host can reach the host a start names (issue #409).
 *
 * A host a start names is reachable when the plane's run can run that
 * host's commands. The herdr host answers only where a herdr server runs:
 * a run that resolved herdr-core stands outside herdr - a herdr mark would
 * have named herdr instead - and the measurement ADR 0141 recorded stands
 * for it, that no herdr server answers there. A herdr run reaches
 * herdr-core: the first core command starts the session's core when none
 * runs, and the run states that effect at boot rather than pre-checking it
 * (ADR 0141). The plane pre-checks nothing it cannot check without causing
 * the effect, so a host whose command cannot run answers at start with its
 * own refusal.
 */
export function agentHostReachable(run: AgentHostResolution, host: AgentHost): boolean {
	if (host === "herdr") return run.host === "herdr";
	return true;
}

/**
 * The one line that names a host the plane's run cannot reach, and the
 * reason (issue #409, ADR 0141). The Consultation launcher's Launch row, the
 * override panel's Agent host row, the start's pre-flight, and the Key
 * guide all state this one line, so the host the plane cannot reach never
 * has two phrasings.
 */
export function agentHostUnreachableLine(host: AgentHost): string {
	return `host ${host} is unreachable from this run: the plane runs outside herdr, and no herdr server answers there`;
}

/**
 * The refusal Goto states on the herdr-core host (ADR 0141): the host
 * answers no focus move, and the line hands the operator the attach command
 * when the Agent's terminal stands on the host. `name` is null for a
 * handoff the run's host cannot reach, and for those the line states the
 * refusal without a command to type.
 */
export function herdrCoreGotoLine(name: string | null): string {
	return name === null
		? "the herdr-core host answers no focus move"
		: `the herdr-core host answers no focus move: type ${HERDR_CORE_COMMAND} attach ${name}`;
}

/**
 * The refusal the Live view states on the herdr-core host (ADR 0141): the
 * host reads a screen as text and answers no styled read, and the Live view
 * built from a fake of that stream is worse than the Live view that is
 * absent.
 */
export const HERDR_CORE_LIVE_VIEW_LINE =
	"the herdr-core host answers no styled read: the Live view is not offered";

/**
 * The version floor of the herdr-core host (ADR 0141): the release every
 * answer shape in the verification record was read against. An older host is
 * one Warning line at the boot, and a shape that host refuses comes back as
 * that host's own reason: the plane does not guess which shape an older core
 * refuses.
 */
export const HERDR_CORE_VERSION_FLOOR = "0.1.20";

/**
 * The herdr-core version read: the one host command the boot may run beside
 * its no-lifecycle rule, because the version flag answers from the binary and
 * starts no core. `binary` is the operator's `[agent-host.herdr-core]`
 * binary, and an unset one stands on the host's own command word.
 */
export function herdrCoreVersionRead(binary?: string): HostInvocation {
	return { command: binary ?? HERDR_CORE_COMMAND, args: ["--version"] };
}

/**
 * The version one `--version` answer carries, or null when it carries none:
 * a failed command and an answer whose lines name no dotted version read as
 * absent. A tool manager's preamble may stand above the answer's line, so the
 * read takes the first line that carries a version, not the first line.
 */
export function herdrCoreVersionOf(result: CommandResult): string | null {
	if (result.code !== 0) {
		return null;
	}
	for (const line of result.stdout.split("\n")) {
		const match = /(\d+\.\d+\.\d+)/.exec(line);
		if (match !== null) return match[1];
	}
	return null;
}

/**
 * Whether one version stands below another, segment by segment on the digits:
 * `0.1.20` stands above `0.1.9`, which a string compare would read the other
 * way. A missing segment stands as zero, so a shorter version stands below a
 * longer one that agrees on every segment it has.
 */
export function versionIsBelow(version: string, above: string): boolean {
	const left = version.split(".").map((part) => Number.parseInt(part, 10));
	const right = above.split(".").map((part) => Number.parseInt(part, 10));
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i += 1) {
		const a = left[i] ?? 0;
		const b = right[i] ?? 0;
		if (a !== b) return a < b;
	}
	return false;
}

/** The one Warning line the boot states for a herdr-core host below the floor. */
export function herdrCoreFloorWarningLine(version: string): string {
	return (
		`the herdr-core host is ${version}, below the plane's version floor ${HERDR_CORE_VERSION_FLOOR}: ` +
		"the plane's answer shapes were read on the floor, and a shape that host refuses comes back as that host's own reason"
	);
}
