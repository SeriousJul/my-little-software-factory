/**
 * The Stub herdr world (ADR 0132): the automated suite's deep adapter for the
 * herdr and git side of the Command runner seam.
 *
 * A test names the world it wants - the checkouts and what each holds, the
 * workspaces, tabs, panes, and Agents already standing - and receives a
 * Command runner. The world is stateful: a create adds to it, a close removes
 * from it, a start stands an Agent in a pane, and every later read answers
 * from what the earlier command left behind. This is the whole difference
 * from the fake command runner, which answers each pin in isolation.
 *
 * The world answers only the command shapes the plane builds, and refuses
 * everything else: an unmodelled command is a refusal that fails the test,
 * never a code-zero fallback. The one behaviour kept from the fake command
 * runner is the held `agent wait`, because a real `agent wait` blocks until
 * its state match and a code-zero answer would wake the observation cycle on
 * every armed Agent.
 *
 * The recording keeps the fake runner's shape: the recorded command list, the
 * settled command list, and the peak concurrency stand exactly as the fake
 * answers them, so the gate and delay wrappers compose over the world
 * unchanged and every shared "this run did not issue that command" claim keeps
 * its teeth.
 *
 * The answer shapes trace to the recorded real herdr answers the plane's
 * readers were verified against (herdr 0.8.2 for the CLI contract, 0.9.1 for
 * the worktree list and the worktree open by path); the shapes the record
 * could not trace stand in the verification record as unverified.
 */
import type {
	CommandOptions,
	CommandResult,
	CommandRunner,
	ModelListResult,
} from "../src/runner.ts";

/** The settle states a pinned `agent wait` answers at once. */
const WAIT_SETTLE_STATES = ["idle", "done", "blocked"] as const;

// ---------------------------------------------------------------------------
// The world description: the standing a test names.
// ---------------------------------------------------------------------------

/** One Agent the world holds. */
export interface WorldAgentDescription {
	/** The herdr name the Agent holds. */
	name: string;
	/** The agent kind herdr reports for it. */
	kind: string;
	/** The status herdr reports: `idle`, `working`, `done`, or `blocked`. */
	status?: string;
	/** The pane the Agent stands in. */
	paneId: string;
	/** The session record path the turn log is read from, when herdr has one. */
	sessionId?: string;
}

/** One pane the world holds. */
export interface WorldPaneDescription {
	id: string;
	/** The tab the pane stands in. */
	tabId: string;
	/** The workspace the tab stands in. */
	workspaceId: string;
	/** The content an `agent read` of the pane returns. */
	content?: string;
	/** A fresh pane not yet at its shell prompt: an `agent start` in it is refused. */
	busy?: boolean;
}

/** One tab the world holds. */
export interface WorldTabDescription {
	id: string;
	/** The workspace the tab stands in. */
	workspaceId: string;
	/** The directory the tab opened in, when it names one. */
	cwd?: string;
}

/** One workspace the world holds. */
export interface WorldWorkspaceDescription {
	id: string;
	/** The checkout or worktree path the workspace stands on. */
	checkoutPath: string;
	/** The label a `workspace get` reads. */
	label?: string;
	/** Whether the workspace is the focused one. */
	focused?: boolean;
	/** A worktree workspace: a `worktree remove` reaches it. */
	isWorktree?: boolean;
}

/** One worktree the world's checkout holds. */
export interface WorldWorktreeDescription {
	/** The path the worktree checkout stands in. */
	path: string;
	/** The branch the worktree works. */
	branch: string;
	/** A worktree git links into the repository; the source checkout is not. */
	linked?: boolean;
	/** A worktree git would prune: gone from disk, or broken. */
	prunable?: boolean;
	/** A worktree with modified or untracked files: a remove without force is refused. */
	dirty?: boolean;
}

/** One branch the world's checkout knows. */
export interface WorldBranchDescription {
	name: string;
	/** The branch stands in the checkout. */
	local?: boolean;
	/** The branch stands on origin. */
	remote?: boolean;
}

/** One checkout the world holds. */
export interface WorldCheckoutDescription {
	/** The path the checkout stands in. */
	path: string;
	/** The URL the checkout's origin remote points at. */
	cloneUrl: string;
	/**
	 * The remote default branch: the `origin/HEAD` symref names it. Absent,
	 * the symref read fails and the Worktree base rule falls back to
	 * `origin/main`, then `origin/master`.
	 */
	defaultBranch?: string;
	/** The checkout's HEAD sha, for a `rev-parse HEAD`. */
	head?: string;
	/**
	 * The directory herdr names this repository's linked worktrees under:
	 * the parent of the worktree checkout a `worktree create` makes.
	 */
	worktreesRoot?: string;
	/** The branches the checkout and origin know. */
	branches?: WorldBranchDescription[];
	/** The worktrees git records for the checkout. */
	worktrees?: WorldWorktreeDescription[];
	/**
	 * The files the remote default branch holds, by path: the answer a
	 * `git show origin/<branch>:<path>` read takes.
	 */
	remoteFiles?: Record<string, string>;
	/**
	 * Whether the checkout's working tree stands dirty: the answer a
	 * `git status --porcelain` read takes.
	 */
	dirty?: boolean;
}

/** The standing a test names for one world. */
export interface HerdrWorldDescription {
	/** The checkouts the world holds, and what each holds. */
	checkouts: WorldCheckoutDescription[];
	/** The workspaces already standing. */
	workspaces?: WorldWorkspaceDescription[];
	/** The tabs already standing. */
	tabs?: WorldTabDescription[];
	/** The panes already standing. */
	panes?: WorldPaneDescription[];
	/** The Agents already standing. */
	agents?: WorldAgentDescription[];
}

// ---------------------------------------------------------------------------
// The world itself.
// ---------------------------------------------------------------------------

/** One Agent the world holds, beside the pane it stands in. */
interface WorldAgent {
	name: string;
	kind: string;
	status: string;
	paneId: string;
	sessionId?: string;
}

interface WorldPane {
	id: string;
	tabId: string;
	workspaceId: string;
	content: string;
	busy: boolean;
}

interface WorldTab {
	id: string;
	workspaceId: string;
	cwd?: string;
}

interface WorldWorkspace {
	id: string;
	checkoutPath: string;
	label?: string;
	focused: boolean;
	isWorktree: boolean;
}

interface WorldBranch {
	sha: string;
	/** The tree sha the branch's tip commit carries. */
	tree: string;
	local: boolean;
	remote: boolean;
}

interface WorldWorktree {
	readonly kind: "worktree";
	path: string;
	branch: string;
	/** The checkout the worktree stands under. */
	owner: WorldCheckout;
	linked: boolean;
	prunable: boolean;
	dirty: boolean;
	/** The HEAD sha of the worktree checkout, for a `rev-parse HEAD` in it. */
	head: string;
	/** The tree sha the worktree's HEAD commit carries. */
	tree: string;
	/** Changes staged in the worktree since its last commit. */
	staged: boolean;
	/** The workspace open on the worktree, if any. */
	openWorkspaceId?: string;
}

interface WorldCheckout {
	readonly kind: "checkout";
	path: string;
	cloneUrl: string;
	defaultBranch?: string;
	head: string;
	worktreesRoot?: string;
	branches: Map<string, WorldBranch>;
	worktrees: WorldWorktree[];
	remoteFiles: Map<string, string>;
	dirty: boolean;
}

/**
 * One command, recorded the way the fake command runner records it: the
 * command name and the argv, one space-joined string per command.
 */
export interface RecordedCommand {
	command: string;
	args: readonly string[];
}

/**
 * The Stub herdr world: the Command runner the tests inject instead of the
 * real runner, answering herdr and git from the standing it holds.
 */
export interface StubHerdrWorld extends CommandRunner {
	/** The raw calls recorded so far, in order, the way the fake records them. */
	readonly calls: readonly RecordedCommand[];
	/** The commands recorded so far, in order. */
	commands(): string[];
	/** The commands that answered, in the order they answered. */
	settledCommands(): string[];
	/** The largest number of commands that ran at the same time. */
	peakConcurrency(): number;
	/** The agent kinds this world was asked for a Model list, in call order. */
	readonly modelListCalls: string[];
	/** Answer one agent kind's Model list query with these models. */
	setModelList(kind: string, models: readonly string[]): void;
	/** Fail one agent kind's Model list query with a readable reason. */
	setModelListFailure(kind: string, reason: string): void;
	/**
	 * Make every Model list query wait, like an agent CLI that has not
	 * answered yet, so a test can see the loading state.
	 */
	holdModelLists(): void;
	/** Let the held Model list queries answer with what the world holds. */
	releaseModelLists(): void;
	/**
	 * Hold one command open until `release` lets it answer, so a test can
	 * watch the window an in-flight operation leaves open.
	 */
	hold(command: string, args: readonly string[]): void;
	/** Let the held command answer. */
	release(command: string, args: readonly string[]): void;
	/**
	 * Make one command raise instead of answering. The command is still
	 * recorded, because the caller did ask for it, and it never settles.
	 */
	raise(command: string, args: readonly string[], message?: string): void;
	/**
	 * Answer one exact command with one result, in place of the world's own
	 * answer, for a test whose subject is the argument.
	 */
	set(command: string, args: readonly string[], result: Partial<CommandResult>): void;
	/** Answer one exact command with a sequence of results, in call order. */
	setSequence(
		command: string,
		args: readonly string[],
		results: readonly Partial<CommandResult>[],
	): void;
	/**
	 * Move the standing of one Agent the world holds: the status the next
	 * `agent list` reports, and the session record path the turn log reads
	 * from. A name the world does not hold is a refusal, not a quiet add.
	 */
	setAgentStatus(name: string, status: string, sessionId?: string): void;
	/** The text chunks a `pane send-text` reached one pane, in send order. */
	sentTextFor(paneId: string): string[];
	/** The keys a `pane send-keys` reached one pane, in send order. */
	sentKeysFor(paneId: string): string[];
}

/** One described checkout, stood in the world's state. */
function buildCheckout(item: WorldCheckoutDescription): WorldCheckout {
	const checkout: WorldCheckout = {
		kind: "checkout",
		path: item.path,
		cloneUrl: item.cloneUrl,
		defaultBranch: item.defaultBranch,
		head: item.head ?? fakeSha(1),
		worktreesRoot: item.worktreesRoot,
		branches: new Map<string, WorldBranch>(),
		worktrees: [],
		remoteFiles: new Map(Object.entries(item.remoteFiles ?? {})),
		dirty: item.dirty === true,
	};
	for (const branch of item.branches ?? []) {
		checkout.branches.set(branch.name, {
			sha: fakeSha(checkout.branches.size + 2),
			tree: treeShaFor(fakeSha(checkout.branches.size + 2)),
			local: branch.local === true,
			remote: branch.remote === true,
		});
	}
	if (checkout.defaultBranch !== undefined) {
		const existing = checkout.branches.get(checkout.defaultBranch);
		checkout.branches.set(checkout.defaultBranch, {
			sha: existing?.sha ?? fakeSha(checkout.branches.size + 2),
			tree: existing?.tree ?? treeShaFor(existing?.sha ?? fakeSha(checkout.branches.size + 2)),
			local: existing?.local ?? false,
			remote: true,
		});
	}
	for (const worktree of item.worktrees ?? []) {
		const head = fakeSha(checkout.worktrees.length + 3);
		checkout.worktrees.push({
			kind: "worktree",
			path: worktree.path,
			branch: worktree.branch,
			owner: checkout,
			linked: worktree.linked ?? true,
			prunable: worktree.prunable === true,
			dirty: worktree.dirty === true,
			head,
			tree: treeShaFor(head),
			staged: false,
		});
	}
	return checkout;
}

/** Build one Stub herdr world on the standing the description names. */
export function stubHerdrWorld(description: HerdrWorldDescription): StubHerdrWorld {
	const checkouts = new Map<string, WorldCheckout>();
	for (const item of description.checkouts) {
		checkouts.set(item.path, buildCheckout(item));
	}
	const workspaces = new Map<string, WorldWorkspace>();
	for (const item of description.workspaces ?? []) {
		workspaces.set(item.id, {
			id: item.id,
			checkoutPath: item.checkoutPath,
			label: item.label,
			focused: item.focused === true,
			isWorktree: item.isWorktree === true,
		});
	}
	const tabs = new Map<string, WorldTab>();
	for (const item of description.tabs ?? []) {
		tabs.set(item.id, { id: item.id, workspaceId: item.workspaceId, cwd: item.cwd });
	}
	const panes = new Map<string, WorldPane>();
	for (const item of description.panes ?? []) {
		panes.set(item.id, {
			id: item.id,
			tabId: item.tabId,
			workspaceId: item.workspaceId,
			content: item.content ?? "",
			busy: item.busy === true,
		});
	}
	const agents = new Map<string, WorldAgent>();
	for (const item of description.agents ?? []) {
		agents.set(item.name, {
			name: item.name,
			kind: item.kind,
			status: item.status ?? "idle",
			paneId: item.paneId,
			sessionId: item.sessionId,
		});
	}

	// The id counters continue past the standing the description names, so a
	// create never collides with a handle the world already holds.
	const nextNumber = (prefix: string, held: Iterable<string>): number => {
		let highest = 0;
		for (const id of held) {
			const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
			if (match !== null) highest = Math.max(highest, Number(match[1]));
		}
		return highest + 1;
	};
	let nextWs = nextNumber("ws", workspaces.keys());
	let nextTab = nextNumber("tab", tabs.keys());
	let nextPane = nextNumber("pane", panes.keys());
	let shaCounter = 100;
	/** The tree sha each commit this world made carries, by its sha. */
	const commits = new Map<string, string>();

	const calls: RecordedCommand[] = [];
	const settled: RecordedCommand[] = [];
	let running = 0;
	let peak = 0;
	const modelListCalls: string[] = [];
	const modelLists = new Map<string, ModelListResult>();
	let modelListGate: Promise<void> | null = null;
	let modelListRelease: (() => void) | null = null;
	const holdGates = new Map<string, Promise<void>>();
	const holdResolvers = new Map<string, () => void>();
	const raises = new Map<string, Error>();
	const overrides = new Map<string, CommandResult>();
	const sequences = new Map<string, CommandResult[]>();
	const sentText = new Map<string, string[]>();
	const sentKeys = new Map<string, string[]>();

	const key = (command: string, args: readonly string[]): string =>
		[command, ...args].join("\u0000");

	const newSha = (): string => fakeSha(shaCounter++);

	// -----------------------------------------------------------------------
	// The stateful world: the create, the close, the start.
	// -----------------------------------------------------------------------

	const addPaneIn = (tabId: string, workspaceId: string, _cwd?: string): WorldPane => {
		const pane: WorldPane = {
			id: `pane-${nextPane++}`,
			tabId,
			workspaceId,
			content: "",
			busy: false,
		};
		panes.set(pane.id, pane);
		return pane;
	};

	const addTabIn = (workspaceId: string, cwd?: string): { tab: WorldTab; pane: WorldPane } => {
		const tab: WorldTab = { id: `tab-${nextTab++}`, workspaceId, cwd };
		tabs.set(tab.id, tab);
		return { tab, pane: addPaneIn(tab.id, workspaceId, cwd) };
	};

	const addWorkspace = (checkoutPath: string, isWorktree = false): WorldWorkspace => {
		const workspace: WorldWorkspace = {
			id: `ws-${nextWs++}`,
			checkoutPath,
			focused: false,
			isWorktree,
		};
		workspaces.set(workspace.id, workspace);
		return workspace;
	};

	const removeAgentsInPanes = (paneIds: Set<string>): void => {
		for (const [name, agent] of agents) {
			if (paneIds.has(agent.paneId)) agents.delete(name);
		}
	};

	const removePanesIn = (tabIds: Set<string>): void => {
		const gone = new Set<string>();
		for (const [id, pane] of panes) {
			if (tabIds.has(pane.tabId)) {
				panes.delete(id);
				gone.add(id);
			}
		}
		removeAgentsInPanes(gone);
	};

	const removeTabsIn = (workspaceIds: Set<string>): void => {
		const gone = new Set<string>();
		for (const [id, tab] of tabs) {
			if (workspaceIds.has(tab.workspaceId)) {
				tabs.delete(id);
				gone.add(id);
			}
		}
		removePanesIn(gone);
	};

	const worktreeAt = (checkout: WorldCheckout, path: string): WorldWorktree | undefined =>
		checkout.worktrees.find((worktree) => worktree.path === path);

	const worktreeByBranch = (checkout: WorldCheckout, branch: string): WorldWorktree | undefined =>
		checkout.worktrees.find((worktree) => worktree.branch === branch);

	const worktreeOpenIn = (_checkout: WorldCheckout, worktree: WorldWorktree): CommandResult => {
		if (worktree.openWorkspaceId !== undefined && workspaces.has(worktree.openWorkspaceId)) {
			// A workspace was already open on the worktree: add a fresh tab in it.
			const { tab, pane } = addTabIn(worktree.openWorkspaceId, worktree.path);
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						already_open: true,
						workspace: { workspace_id: worktree.openWorkspaceId },
						tab: { tab_id: tab.id },
						root_pane: { pane_id: pane.id },
						worktree: { path: worktree.path },
					},
				}),
				stderr: "",
			};
		}
		// herdr attaches a fresh workspace on the worktree.
		const workspace = addWorkspace(worktree.path, true);
		workspace.isWorktree = true;
		const { tab, pane } = addTabIn(workspace.id, worktree.path);
		worktree.openWorkspaceId = workspace.id;
		return {
			code: 0,
			stdout: JSON.stringify({
				result: {
					already_open: false,
					workspace: { workspace_id: workspace.id },
					tab: { tab_id: tab.id },
					root_pane: { pane_id: pane.id },
					worktree: { path: worktree.path },
				},
			}),
			stderr: "",
		};
	};

	// -----------------------------------------------------------------------
	// The herdr surface: every shape the plane builds, and no others.
	// -----------------------------------------------------------------------

	const herdrError = (code: string, message: string, id?: string): CommandResult => {
		const envelope: Record<string, unknown> = { error: { code, message } };
		if (id !== undefined) envelope.id = id;
		return { code: 1, stdout: "", stderr: `${JSON.stringify(envelope)}\n` };
	};

	const answerHerdr = (args: readonly string[]): CommandResult | "hold" => {
		const verb = args[0];
		switch (verb) {
			case "agent":
				return answerAgent(args);
			case "pane":
				return answerPane(args);
			case "tab":
				return answerTab(args);
			case "workspace":
				return answerWorkspace(args);
			case "worktree":
				return answerWorktree(args);
			default:
				return unmodelled(`herdr ${args.join(" ")}`);
		}
	};

	const answerAgent = (args: readonly string[]): CommandResult | "hold" => {
		const sub = args[1];
		switch (sub) {
			case "list":
				return {
					code: 0,
					stdout: JSON.stringify({
						result: {
							agents: [...agents.values()].map((agent) => {
								const item: Record<string, unknown> = {
									pane_id: agent.paneId,
									tab_id: panes.get(agent.paneId)?.tabId ?? "",
									workspace_id: panes.get(agent.paneId)?.workspaceId ?? "",
									agent: agent.kind,
									agent_status: agent.status,
									name: agent.name,
								};
								if (agent.sessionId !== undefined)
									item.agent_session = {
										kind: "path",
										source: "herdr:stub",
										value: agent.sessionId,
									};
								return item;
							}),
						},
					}),
					stderr: "",
				};
			case "wait":
				return answerAgentWait(args[2]);
			case "read":
				return answerAgentRead(args[2]);
			case "focus":
				return panes.has(args[2])
					? { code: 0, stdout: "", stderr: "" }
					: herdrError("pane_not_found", `pane ${args[2]} not found`);
			case "prompt":
				return agents.has(args[2])
					? { code: 0, stdout: "", stderr: "" }
					: herdrError("agent_not_found", `no agent named ${args[2]}`);
			case "start":
				return answerAgentStart(args);
			default:
				return unmodelled(`herdr agent ${sub}`);
		}
	};

	/**
	 * The pinned `agent wait`: the one block the fake runner's fallback models.
	 * A settle state the world holds answers at once, and every other target
	 * holds, the way the real command blocks.
	 */
	const answerAgentWait = (target: string | undefined): CommandResult | "hold" => {
		const agent = target !== undefined ? agents.get(target) : undefined;
		if (
			agent !== undefined &&
			WAIT_SETTLE_STATES.includes(agent.status as (typeof WAIT_SETTLE_STATES)[number])
		)
			return { code: 0, stdout: "", stderr: "" };
		return "hold";
	};

	const answerAgentRead = (paneId: string | undefined): CommandResult => {
		const pane = paneId !== undefined ? panes.get(paneId) : undefined;
		if (pane === undefined) return herdrError("pane_not_found", `pane ${paneId} not found`);
		return { code: 0, stdout: pane.content, stderr: "" };
	};

	// The holder herdr 0.8.2 writes into the refusal, in the order the
	// plane's collision reader parses: terminal, pane, workspace, tab, cwd,
	// status.
	const nameTakenError = (name: string, holder: WorldAgent): CommandResult => {
		const pane = panes.get(holder.paneId);
		const workspace = pane !== undefined ? workspaces.get(pane.workspaceId) : undefined;
		const message =
			`agent name ${name} is already used: terminal_id=${holder.paneId} ` +
			`pane_id=${holder.paneId} workspace_id=${pane?.workspaceId ?? ""} ` +
			`tab_id=${pane?.tabId ?? ""} cwd=${workspace?.checkoutPath ?? ""} status=${holder.status}`;
		return herdrError("agent_name_taken", message, "cli:agent:start");
	};

	// The argv: agent start <name> --kind <kind> --pane <pane> [-- ...]. The
	// runtime's own arguments ride after `--`, and never name a herdr flag.
	const parseStartFlags = (args: readonly string[]): { kind: string; paneId: string } => {
		let kind = "";
		let paneId = "";
		for (let i = 3; i < args.length; i += 1) {
			if (args[i] === "--") break;
			if (args[i] === "--kind") kind = args[i + 1] ?? "";
			if (args[i] === "--pane") paneId = args[i + 1] ?? "";
		}
		return { kind, paneId };
	};

	const answerAgentStart = (args: readonly string[]): CommandResult => {
		const name = args[2];
		const { kind, paneId } = parseStartFlags(args);
		const holder = name !== undefined ? agents.get(name) : undefined;
		if (holder !== undefined) return nameTakenError(name, holder);
		const pane = panes.get(paneId);
		if (pane === undefined)
			return herdrError("agent_start_failed", `the pane ${paneId} is gone`, "cli:agent:start");
		if (pane.busy)
			return herdrError(
				"agent_pane_busy",
				`agent target pane ${paneId} is not an available shell`,
				"cli:agent:start",
			);
		agents.set(name, { name, kind, status: "idle", paneId: pane.id });
		pane.busy = false;
		return {
			code: 0,
			stdout: JSON.stringify({ result: { agent: { name, status: "idle" } } }),
			stderr: "",
		};
	};

	const recordTo = (
		paneId: string,
		words: readonly string[],
		record: Map<string, string[]>,
	): CommandResult => {
		if (!panes.has(paneId)) return herdrError("pane_not_found", `pane ${paneId} not found`);
		record.set(paneId, [...(record.get(paneId) ?? []), ...(words ?? [])]);
		return { code: 0, stdout: "", stderr: "" };
	};

	const answerPaneList = (args: readonly string[]): CommandResult => {
		const workspaceId = flagValue(args, "--workspace");
		if (workspaceId === undefined || !workspaces.has(workspaceId))
			return herdrError("workspace_not_found", `workspace ${workspaceId} not found`);
		return {
			code: 0,
			stdout: JSON.stringify({
				result: {
					panes: [...panes.values()]
						.filter((pane) => pane.workspaceId === workspaceId)
						.map((pane) => ({ pane_id: pane.id, tab_id: pane.tabId })),
				},
			}),
			stderr: "",
		};
	};

	const answerPane = (args: readonly string[]): CommandResult => {
		const sub = args[1];
		const target = args[2];
		if (target === undefined) return unmodelled(`herdr pane ${sub}`);
		if (sub === "send-keys") return recordTo(target, args.slice(3), sentKeys);
		if (sub === "send-text") return recordTo(target, args.slice(3), sentText);
		if (sub === "list") return answerPaneList(args);
		if (sub === "close") return answerPaneClose(target);
		return unmodelled(`herdr pane ${sub}`);
	};

	/** `pane close`: the pane goes away, and its empty tab or workspace with it. */
	const answerPaneClose = (paneId: string): CommandResult => {
		const pane = panes.get(paneId);
		if (pane === undefined)
			return herdrError("pane_not_found", `pane ${paneId} not found`, "cli:pane:close");
		panes.delete(paneId);
		const tab = tabs.get(pane.tabId);
		if (tab !== undefined && ![...panes.values()].some((item) => item.tabId === tab.id)) {
			tabs.delete(tab.id);
			const workspace = workspaces.get(tab.workspaceId);
			if (
				workspace !== undefined &&
				![...tabs.values()].some((item) => item.workspaceId === workspace.id)
			)
				workspaces.delete(workspace.id);
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	const answerTabCreate = (args: readonly string[]): CommandResult => {
		const workspaceId = flagValue(args, "--workspace");
		if (workspaceId === undefined || !workspaces.has(workspaceId))
			return herdrError("workspace_not_found", `workspace ${workspaceId} not found`);
		const { tab, pane } = addTabIn(workspaceId, flagValue(args, "--cwd"));
		return {
			code: 0,
			stdout: JSON.stringify({
				result: { tab: { tab_id: tab.id }, root_pane: { pane_id: pane.id } },
			}),
			stderr: "",
		};
	};

	const answerTabClose = (args: readonly string[]): CommandResult => {
		const tab = args[2] !== undefined ? tabs.get(args[2]) : undefined;
		if (tab === undefined)
			return herdrError("tab_not_found", `tab ${args[2]} not found`, "cli:tab:close");
		tabs.delete(tab.id);
		removePanesIn(new Set([tab.id]));
		return { code: 0, stdout: "", stderr: "" };
	};

	const answerTabList = (args: readonly string[]): CommandResult => {
		const workspaceId = flagValue(args, "--workspace");
		if (workspaceId === undefined || !workspaces.has(workspaceId))
			return herdrError("workspace_not_found", `workspace ${workspaceId} not found`);
		return {
			code: 0,
			stdout: JSON.stringify({
				result: {
					tabs: [...tabs.values()]
						.filter((tab) => tab.workspaceId === workspaceId)
						.map((tab) => ({ tab_id: tab.id })),
				},
			}),
			stderr: "",
		};
	};

	const answerTab = (args: readonly string[]): CommandResult => {
		const sub = args[1];
		if (sub === "create") return answerTabCreate(args);
		if (sub === "close") return answerTabClose(args);
		if (sub === "list") return answerTabList(args);
		return unmodelled(`herdr tab ${sub}`);
	};

	const answerWorkspace = (args: readonly string[]): CommandResult => {
		const sub = args[1];
		switch (sub) {
			case "list":
				return {
					code: 0,
					stdout: JSON.stringify({
						result: {
							workspaces: [...workspaces.values()].map((workspace) => ({
								workspace_id: workspace.id,
								focused: workspace.focused,
								worktree: { checkout_path: workspace.checkoutPath },
							})),
						},
					}),
					stderr: "",
				};
			case "create": {
				const cwd = flagValue(args, "--cwd");
				if (cwd === undefined) return unmodelled("herdr workspace create");
				const workspace = addWorkspace(cwd);
				const { tab, pane } = addTabIn(workspace.id, cwd);
				return {
					code: 0,
					stdout: JSON.stringify({
						result: {
							workspace: { workspace_id: workspace.id },
							tab: { tab_id: tab.id },
							root_pane: { pane_id: pane.id },
						},
					}),
					stderr: "",
				};
			}
			case "get":
				return answerWorkspaceGet(args[2]);
			case "close": {
				const workspace = args[2] !== undefined ? workspaces.get(args[2]) : undefined;
				if (workspace === undefined)
					return herdrError("workspace_not_found", `workspace ${args[2]} not found`);
				workspaces.delete(workspace.id);
				removeTabsIn(new Set([workspace.id]));
				return { code: 0, stdout: "", stderr: "" };
			}
			default:
				return unmodelled(`herdr workspace ${sub}`);
		}
	};

	const answerWorkspaceGet = (workspaceId: string | undefined): CommandResult => {
		const workspace = workspaceId !== undefined ? workspaces.get(workspaceId) : undefined;
		if (workspace === undefined)
			return herdrError("workspace_not_found", `workspace ${workspaceId} not found`);
		return {
			code: 0,
			stdout: JSON.stringify({
				result: {
					type: "workspace_info",
					workspace: {
						focused: workspace.focused,
						label: workspace.label ?? workspace.id,
						workspace_id: workspace.id,
					},
				},
			}),
			stderr: "",
		};
	};

	const answerWorktree = (args: readonly string[]): CommandResult => {
		const sub = args[1];
		const checkoutPath = flagValue(args, "--cwd");
		const checkout = checkoutPath !== undefined ? checkouts.get(checkoutPath) : undefined;
		switch (sub) {
			case "list":
				if (checkout === undefined) return unmodelled(`herdr worktree list --cwd ${checkoutPath}`);
				return {
					code: 0,
					stdout: JSON.stringify({
						id: "cli:worktree:list",
						result: {
							type: "worktree_list",
							worktrees: checkout.worktrees.map((worktree) => ({
								...(worktree.branch !== undefined && { branch: worktree.branch }),
								is_linked_worktree: worktree.linked,
								is_prunable: worktree.prunable,
								path: worktree.path,
								...(worktree.openWorkspaceId !== undefined && {
									open_workspace_id: worktree.openWorkspaceId,
								}),
							})),
						},
					}),
					stderr: "",
				};
			case "open":
				return answerWorktreeOpen(args, checkout);
			case "create":
				return answerWorktreeCreate(args, checkout);
			case "remove":
				return answerWorktreeRemove(args);
			default:
				return unmodelled(`herdr worktree ${sub}`);
		}
	};

	const answerWorktreeOpen = (
		args: readonly string[],
		checkout: WorldCheckout | undefined,
	): CommandResult => {
		if (checkout === undefined)
			return unmodelled(`herdr worktree open --cwd ${flagValue(args, "--cwd")}`);
		const branch = flagValue(args, "--branch");
		const path = flagValue(args, "--path");
		const worktree =
			branch !== undefined
				? worktreeByBranch(checkout, branch)
				: path !== undefined
					? worktreeAt(checkout, path)
					: undefined;
		if (worktree === undefined)
			return herdrError("worktree_not_found", "worktree branch not found", "cli:worktree:open");
		return worktreeOpenIn(checkout, worktree);
	};

	const answerWorktreeCreate = (
		args: readonly string[],
		checkout: WorldCheckout | undefined,
	): CommandResult => {
		if (checkout === undefined)
			return unmodelled(`herdr worktree create --cwd ${flagValue(args, "--cwd")}`);
		const branch = flagValue(args, "--branch");
		if (branch === undefined) return unmodelled("herdr worktree create");
		if (checkout.branches.has(branch))
			return {
				code: 1,
				stdout: "",
				stderr: `fatal: a branch named '${branch}' already exists\n`,
			};
		const base = flagValue(args, "--base");
		if (base !== undefined && !branchRefHolds(checkout, base))
			return {
				code: 1,
				stdout: "",
				stderr: `fatal: invalid reference: ${base}\n`,
			};
		const root = checkout.worktreesRoot ?? linkedWorktreeRoot(checkout);
		if (root === undefined)
			return unmodelled(`herdr worktree create --cwd ${checkout.path} --branch ${branch}`);
		const head = newSha();
		const worktree: WorldWorktree = {
			kind: "worktree",
			path: `${root}/${branch.replaceAll("/", "-")}`,
			branch,
			owner: checkout,
			linked: true,
			prunable: false,
			dirty: false,
			head,
			tree: treeShaFor(head),
			staged: false,
		};
		checkout.worktrees.push(worktree);
		checkout.branches.set(branch, {
			sha: worktree.head,
			tree: worktree.tree,
			local: true,
			remote: false,
		});
		const workspace = addWorkspace(worktree.path, true);
		const { tab, pane } = addTabIn(workspace.id, worktree.path);
		worktree.openWorkspaceId = workspace.id;
		return {
			code: 0,
			stdout: JSON.stringify({
				result: {
					workspace: { workspace_id: workspace.id },
					tab: { tab_id: tab.id },
					root_pane: { pane_id: pane.id },
				},
			}),
			stderr: "",
		};
	};

	const answerWorktreeRemove = (args: readonly string[]): CommandResult => {
		const workspaceId = flagValue(args, "--workspace");
		const force = args.includes("--force");
		const workspace = workspaceId !== undefined ? workspaces.get(workspaceId) : undefined;
		if (workspace === undefined)
			return herdrError("workspace_not_found", `workspace ${workspaceId} not found`);
		const worktree = checkoutOfWorkspace(workspace)?.worktrees.find(
			(item) => item.openWorkspaceId === workspaceId,
		);
		if (worktree === undefined) {
			// The checkout is gone (deleted outside herdr): the workspace is
			// what remains, and the plane's close falls back to it.
			return herdrError(
				"worktree_remove_failed",
				"fatal: the path is not a working tree",
				"cli:worktree:remove",
			);
		}
		if (worktree.dirty && !force) {
			return herdrError(
				"dirty_worktree_requires_force",
				"fatal: the worktree contains modified or untracked files, use --force to delete it",
				"cli:worktree:remove",
			);
		}
		worktree.owner.worktrees = worktree.owner.worktrees.filter((item) => item !== worktree);
		workspaces.delete(workspace.id);
		removeTabsIn(new Set([workspace.id]));
		return { code: 0, stdout: "", stderr: "" };
	};

	const checkoutOfWorkspace = (workspace: WorldWorkspace): WorldCheckout | undefined => {
		for (const checkout of checkouts.values()) {
			if (checkout.worktrees.some((worktree) => worktree.openWorkspaceId === workspace.id))
				return checkout;
		}
		return undefined;
	};

	/** The parent of the checkout's linked worktrees, when one reads. */
	const linkedWorktreeRoot = (checkout: WorldCheckout): string | undefined => {
		const linked = checkout.worktrees.find((worktree) => worktree.linked);
		if (linked === undefined) return undefined;
		const parent = linked.path.slice(0, linked.path.lastIndexOf("/"));
		return parent === "" ? undefined : parent;
	};

	/** Whether the checkout's refs hold a `origin/<branch>` or a local branch. */
	const branchRefHolds = (checkout: WorldCheckout, ref: string): boolean => {
		if (ref.startsWith("origin/"))
			return checkout.branches.get(ref.slice("origin/".length))?.remote === true;
		return checkout.branches.has(ref);
	};

	// -----------------------------------------------------------------------
	// The git surface: every shape the plane builds, and no others.
	// ---------------------------------------------------------------------------

	const answerGitClone = (args: readonly string[]): CommandResult => {
		const url = args[1];
		const path = args[2];
		if (url === undefined || path === undefined) return unmodelled("git clone");
		checkouts.set(path, {
			kind: "checkout",
			path,
			cloneUrl: url,
			head: newSha(),
			branches: new Map(),
			worktrees: [],
			remoteFiles: new Map(),
			dirty: false,
		});
		return { code: 0, stdout: "", stderr: "" };
	};

	const answerGit = (args: readonly string[]): CommandResult => {
		if (args[0] === "clone") return answerGitClone(args);
		const cIndex = args.indexOf("-C");
		const path = cIndex >= 0 ? args[cIndex + 1] : undefined;
		const rest = cIndex >= 0 ? args.slice(cIndex + 2) : args;
		if (path === undefined) return unmodelled(`git ${args.join(" ")}`);
		const worktree = pathWorktree(path);
		if (worktree !== undefined) return answerGitInWorktree(worktree, rest);
		const checkout = checkouts.get(path);
		if (checkout === undefined) {
			// A path the world does not hold: the git answers the plane reads
			// for a missing checkout.
			return gitPathMissing(path, rest);
		}
		return answerGitInCheckout(checkout, rest);
	};

	/** The worktree the world holds at one path, for a `-C <path>` in it. */
	const pathWorktree = (path: string): WorldWorktree | undefined => {
		for (const checkout of checkouts.values()) {
			const worktree = checkout.worktrees.find((item) => item.path === path);
			if (worktree !== undefined) return worktree;
		}
		return undefined;
	};

	const gitFatal = (message: string): CommandResult => ({
		code: 128,
		stdout: "",
		stderr: `fatal: ${message}\n`,
	});

	/** The git answers for a path the world does not hold at all. */
	const gitPathMissing = (path: string, rest: readonly string[]): CommandResult => {
		if (rest[0] === "rev-parse" && rest[1] === "--git-dir")
			return gitFatal(`not a git repository (working tree '${path}')`);
		if (rest[0] === "remote" && rest[1] === "get-url")
			return gitFatal(`not a git repository (working tree '${path}')`);
		return unmodelled(`git -C ${path} ${rest.join(" ")}`);
	};

	const answerGitInWorktree = (worktree: WorldWorktree, rest: readonly string[]): CommandResult => {
		switch (rest[0]) {
			case "rev-parse":
				if (rest[1] === "HEAD") return { code: 0, stdout: `${worktree.head}\n`, stderr: "" };
				return unmodelled(`git rev-parse ${rest.slice(1).join(" ")}`);
			case "status":
				return {
					code: 0,
					stdout: worktree.staged ? `M  .factory-init\n` : "",
					stderr: "",
				};
			case "add":
				worktree.staged = true;
				return { code: 0, stdout: "", stderr: "" };
			case "commit":
				if (!worktree.staged)
					return { code: 1, stdout: "", stderr: "nothing to commit, working tree clean\n" };
				worktree.staged = false;
				worktree.head = newSha();
				worktree.tree = treeShaFor(worktree.head);
				return {
					code: 0,
					stdout: `[detached HEAD ${worktree.head.slice(0, 7)}] ${rest.at(-1) ?? ""}\n`,
					stderr: "",
				};
			case "push":
				return gitPushFor(worktree, rest);
			default:
				return unmodelled(`git -C ${worktree.path} ${rest.join(" ")}`);
		}
	};

	const answerGitInCheckout = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		switch (rest[0]) {
			case "rev-parse":
				return answerGitRevParse(checkout, rest);
			case "remote":
				return answerGitRemote(checkout, rest);
			case "symbolic-ref":
				return answerGitSymbolicRef(checkout, rest);
			case "branch":
				return answerGitBranch(checkout, rest);
			case "fetch":
				return answerGitFetch(checkout, rest);
			case "ls-remote":
				return answerGitLsRemote(checkout, rest);
			case "status":
				return answerGitStatus(checkout, rest);
			case "commit-tree":
				return answerGitCommitTree(checkout, rest);
			case "update-ref":
				return answerGitUpdateRef(checkout, rest);
			case "diff":
				return answerGitDiff(checkout, rest);
			case "push":
				return gitPushFor(checkout, rest);
			case "worktree":
				return answerGitWorktree(checkout, rest);
			case "show":
				return answerGitShow(checkout, rest);
			default:
				return unmodelled(`git ${rest.join(" ")}`);
		}
	};

	// `origin/<branch>^{commit}`: the Worktree base rule's candidate check.
	const candidateCheck = (checkout: WorldCheckout, ref: string): CommandResult => {
		const remote = ref.startsWith("origin/");
		const branch = checkout.branches.get(remote ? ref.slice("origin/".length) : ref);
		if (branch !== undefined && (remote ? branch.remote : branch.local))
			return { code: 0, stdout: `${branch.sha}\n`, stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	};

	// `rev-parse <branch> <branch>^{tree}`: the branch's tip and tree.
	const tipAndTree = (checkout: WorldCheckout, branchName: string): CommandResult => {
		const branch = checkout.branches.get(branchName);
		if (branch !== undefined)
			return { code: 0, stdout: `${branch.sha}\n${branch.tree}\n`, stderr: "" };
		return gitFatal(`ambiguous argument '${branchName}'`);
	};

	const answerGitRevParse = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		if (rest[1] === "--git-dir") return { code: 0, stdout: ".git\n", stderr: "" };
		if (rest[1] === "HEAD") return { code: 0, stdout: `${checkout.head}\n`, stderr: "" };
		if (rest[1] === "--verify" && rest[2] === "--quiet" && rest[3] !== undefined)
			return candidateCheck(checkout, rest[3].replace(/\^.*$/, ""));
		if (rest.length === 3 && rest[1] === rest[2].replace(/\^.*$/, ""))
			return tipAndTree(checkout, rest[1]);
		return unmodelled(`git rev-parse ${rest.slice(1).join(" ")}`);
	};

	const answerGitBranch = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		if (rest[1] === "--list" && rest[2] !== undefined) {
			const branch = checkout.branches.get(rest[2]);
			return {
				code: 0,
				stdout: branch?.local ? `  ${rest[2]}\n` : "",
				stderr: "",
			};
		}
		if (rest[1] === "-D" && rest[2] !== undefined) {
			const branch = checkout.branches.get(rest[2]);
			if (branch === undefined) return gitFatal(`branch '${rest[2]}' not found`);
			checkout.branches.delete(rest[2]);
			return { code: 0, stdout: `Deleted branch ${rest[2]} (was ${branch.sha}).\n`, stderr: "" };
		}
		return unmodelled(`git branch ${rest.slice(1).join(" ")}`);
	};

	const answerGitFetch = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		// `fetch origin <ref>[:<local>]` and `fetch origin <head> <base>`.
		const refs = rest.slice(2);
		for (const ref of refs) {
			const local = ref.split(":")[1];
			const remote = ref.split(":")[0].replace(/^origin\//, "");
			const existing = checkout.branches.get(remote);
			const sha = existing?.sha ?? newSha();
			checkout.branches.set(remote, {
				sha,
				tree: existing?.tree ?? treeShaFor(sha),
				local:
					(existing?.local ?? false) || (local !== undefined && local === `refs/heads/${remote}`),
				remote: true,
			});
		}
		return { code: 0, stdout: "", stderr: "" };
	};

	/** `status --porcelain [--untracked-files=all]`: the checkout's dirty standing. */
	const answerGitStatus = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		if (rest[1] !== "--porcelain" || (rest[2] !== undefined && rest[2] !== "--untracked-files=all"))
			return unmodelled(`git status ${rest.join(" ")}`);
		return { code: 0, stdout: checkout.dirty ? `M  .factory-init\n` : "", stderr: "" };
	};

	const answerGitLsRemote = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		// `ls-remote --heads origin <branch>`: the standing remote's answer.
		const branch = rest[rest.length - 1];
		const held = branch !== undefined ? checkout.branches.get(branch) : undefined;
		if (held?.remote) return { code: 0, stdout: `${held.sha}\trefs/heads/${branch}\n`, stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};

	const pushInCheckout = (checkout: WorldCheckout, refspec: string): CommandResult => {
		// `push --no-verify origin <branch>`, or `HEAD:<branch>` from a checkout.
		const [source, target] = refspec.split(":");
		const name = target ?? source;
		const sourceBranch = source === "HEAD" ? undefined : checkout.branches.get(source);
		if (source !== "HEAD" && sourceBranch === undefined)
			return {
				code: 1,
				stdout: "",
				stderr: `error: src refspec '${refspec}' does not match any\n`,
			};
		const held = checkout.branches.get(name);
		checkout.branches.set(name, {
			sha: held?.sha ?? sourceBranch?.sha ?? checkout.head,
			tree: held?.tree ?? sourceBranch?.tree ?? treeShaFor(held?.sha ?? checkout.head),
			local: held?.local ?? source === "HEAD",
			remote: true,
		});
		return { code: 0, stdout: `To ${checkout.cloneUrl}\n`, stderr: "" };
	};

	// The throwaway worktree pushes its detached HEAD to the remote branch.
	const pushInWorktree = (worktree: WorldWorktree, refspec: string): CommandResult => {
		const target = (refspec.split(":")[1] ?? refspec).replace(/^refs\/heads\//, "");
		const existing = worktree.owner.branches.get(target);
		worktree.owner.branches.set(target, {
			sha: existing?.sha ?? worktree.head,
			tree: existing?.tree ?? worktree.tree,
			local: existing?.local ?? false,
			remote: true,
		});
		return { code: 0, stdout: `To ${worktree.owner.cloneUrl}\n`, stderr: "" };
	};

	const gitPushFor = (
		value: WorldCheckout | WorldWorktree,
		rest: readonly string[],
	): CommandResult => {
		const refspec = rest[rest.length - 1] ?? "";
		if (value.kind === "checkout") return pushInCheckout(value, refspec);
		return pushInWorktree(value, refspec);
	};

	const answerGitRemote = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		if (rest[1] === "get-url" && rest[2] === "origin")
			return { code: 0, stdout: `${checkout.cloneUrl}\n`, stderr: "" };
		return unmodelled(`git remote ${rest.slice(1).join(" ")}`);
	};

	const answerGitSymbolicRef = (
		checkout: WorldCheckout,
		rest: readonly string[],
	): CommandResult => {
		if (rest[1] !== "refs/remotes/origin/HEAD")
			return unmodelled(`git symbolic-ref ${rest.slice(1).join(" ")}`);
		if (checkout.defaultBranch === undefined)
			return { code: 1, stdout: "", stderr: "fatal: ref HEAD is not a symbolic ref\n" };
		return { code: 0, stdout: `refs/remotes/origin/${checkout.defaultBranch}\n`, stderr: "" };
	};

	const answerGitUpdateRef = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		if (rest[1]?.startsWith("refs/heads/") && rest[2] !== undefined) {
			const branch = checkout.branches.get(rest[1].slice("refs/heads/".length));
			if (branch !== undefined) {
				branch.sha = rest[2];
				branch.tree = commits.get(rest[2]) ?? treeShaFor(rest[2]);
			}
			return { code: 0, stdout: "", stderr: "" };
		}
		return unmodelled(`git update-ref ${rest.slice(1).join(" ")}`);
	};

	/** `commit-tree <tree> -p <parent> -m <msg>`: a commit with the named tree. */
	const answerGitCommitTree = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		void checkout;
		const sha = newSha();
		const tree = rest[1] ?? "";
		if (tree !== "") commits.set(sha, tree);
		return { code: 0, stdout: `${sha}\n`, stderr: "" };
	};

	/** `diff --quiet origin/<base> origin/<head>`: 0 alike, 1 apart, else failure. */
	const answerGitDiff = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		if (rest[1] !== "--quiet" || rest[2] === undefined || rest[3] === undefined)
			return unmodelled(`git diff ${rest.join(" ")}`);
		const branchOf = (ref: string) =>
			checkout.branches.get(ref.startsWith("origin/") ? ref.slice("origin/".length) : ref);
		const left = branchOf(rest[2]);
		const right = branchOf(rest[3]);
		if (left?.remote !== true || right?.remote !== true) return gitFatal("ambiguous argument");
		return { code: left.tree === right.tree ? 0 : 1, stdout: "", stderr: "" };
	};

	/** The git `worktree add` and `worktree remove --force` of the init. */
	const answerGitWorktree = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		if (
			rest[1] === "add" &&
			rest[2] === "--detach" &&
			rest[3] !== undefined &&
			rest[4] !== undefined
		) {
			const path = rest[3];
			const ref = rest[4].replace(/^origin\//, "");
			const branch = checkout.branches.get(ref);
			if (branch === undefined) return gitFatal(`reference is not a sha: ${rest[4]}`);
			checkout.worktrees.push({
				kind: "worktree",
				path,
				branch: ref,
				owner: checkout,
				linked: false,
				prunable: false,
				dirty: false,
				head: branch.sha,
				tree: branch.tree,
				staged: false,
			});
			return { code: 0, stdout: "", stderr: "" };
		}
		if (rest[1] === "remove" && rest[2] === "--force" && rest[3] !== undefined) {
			const index = checkout.worktrees.findIndex((worktree) => worktree.path === rest[3]);
			if (index < 0) return gitFatal(`'${rest[3]}' is not a working tree`);
			checkout.worktrees.splice(index, 1);
			return { code: 0, stdout: "", stderr: "" };
		}
		return unmodelled(`git worktree ${rest.slice(1).join(" ")}`);
	};

	const answerGitShow = (checkout: WorldCheckout, rest: readonly string[]): CommandResult => {
		// `show origin/<branch>:<path>`: the remote file the init plans against.
		const refAndPath = rest[1] ?? "";
		const separator = refAndPath.lastIndexOf(":");
		if (separator <= 0) return unmodelled(`git show ${refAndPath}`);
		const ref = refAndPath.slice(0, separator);
		const path = refAndPath.slice(separator + 1);
		const branch = ref.startsWith("origin/")
			? checkout.branches.get(ref.slice("origin/".length))
			: checkout.branches.get(ref);
		if (branch === undefined) return gitFatal(`unknown revision '${ref}'`);
		const content = checkout.remoteFiles.get(path);
		if (content === undefined) return gitFatal(`path '${path}' does not exist in '${ref}'`);
		return { code: 0, stdout: content, stderr: "" };
	};

	/** A command no side of the world models: the refusal that fails the test. */
	const unmodelled = (name: string): CommandResult => ({
		code: 1,
		stdout: "",
		stderr: `the Stub herdr world answers no ${name}\n`,
	});

	/** The world's own answer for one command, or the hold for the `agent wait`. */
	const worldAnswer = (command: string, args: readonly string[]): CommandResult | "hold" => {
		if (command === "herdr") return answerHerdr(args);
		if (command === "git") return answerGit(args);
		return unmodelled(`${command} ${args.join(" ")}`);
	};

	const world: StubHerdrWorld = {
		calls,
		async run(
			command: string,
			args: readonly string[],
			options?: CommandOptions,
		): Promise<CommandResult> {
			void options;
			calls.push({ command, args });
			const k = key(command, args);
			running += 1;
			peak = Math.max(peak, running);
			const gate = holdGates.get(k);
			if (gate !== undefined) await gate;
			const raise = raises.get(k);
			if (raise !== undefined) throw raise;
			const sequence = sequences.get(k);
			const next = sequence !== undefined && sequence.length > 0 ? sequence.shift() : undefined;
			const override = next ?? overrides.get(k);
			const answer = override ?? worldAnswer(command, args);
			if (answer === "hold") {
				// The held `agent wait`: it stays counted as running, the way the
				// fake's blocking fallback does.
				return new Promise<CommandResult>(() => undefined);
			}
			running -= 1;
			settled.push({ command, args });
			return answer;
		},
		async listModels(kind: string): Promise<ModelListResult> {
			modelListCalls.push(kind);
			await modelListGate;
			return (
				modelLists.get(kind) ?? {
					ok: false,
					reason: `the Stub herdr world holds no model list for kind "${kind}"`,
				}
			);
		},
		commands(): string[] {
			return calls.map((c) => `${c.command} ${c.args.join(" ")}`.trim());
		},
		settledCommands(): string[] {
			return settled.map((c) => `${c.command} ${c.args.join(" ")}`.trim());
		},
		peakConcurrency(): number {
			return peak;
		},
		modelListCalls,
		setModelList(kind: string, models: readonly string[]): void {
			modelLists.set(kind, { ok: true, models: [...models] });
		},
		setModelListFailure(kind: string, reason: string): void {
			modelLists.set(kind, { ok: false, reason });
		},
		holdModelLists(): void {
			if (modelListRelease !== null) return;
			modelListGate = new Promise<void>((resolve) => {
				modelListRelease = resolve;
			});
		},
		releaseModelLists(): void {
			const release = modelListRelease;
			modelListRelease = null;
			modelListGate = Promise.resolve();
			release?.();
		},
		hold(command: string, args: readonly string[]): void {
			const k = key(command, args);
			if (holdGates.has(k)) return;
			let resolve: () => void = () => undefined;
			holdGates.set(
				k,
				new Promise<void>((r) => {
					resolve = r;
				}),
			);
			holdResolvers.set(k, resolve);
		},
		release(command: string, args: readonly string[]): void {
			const k = key(command, args);
			const resolve = holdResolvers.get(k);
			if (resolve !== undefined) {
				resolve();
				holdGates.delete(k);
				holdResolvers.delete(k);
			}
		},
		raise(command: string, args: readonly string[], message = "the command raised"): void {
			raises.set(key(command, args), new Error(message));
		},
		set(command: string, args: readonly string[], result: Partial<CommandResult>): void {
			overrides.set(key(command, args), { code: 0, stdout: "", stderr: "", ...result });
		},
		setSequence(
			command: string,
			args: readonly string[],
			results: readonly Partial<CommandResult>[],
		): void {
			sequences.set(
				key(command, args),
				results.map((result) => ({ code: 0, stdout: "", stderr: "", ...result })),
			);
		},
		setAgentStatus(name: string, status: string, sessionId?: string): void {
			const agent = agents.get(name);
			if (agent === undefined) throw new Error(`the world holds no agent named ${name}`);
			agent.status = status;
			agent.sessionId = sessionId;
		},
		sentTextFor(paneId: string): string[] {
			return [...(sentText.get(paneId) ?? [])];
		},
		sentKeysFor(paneId: string): string[] {
			return [...(sentKeys.get(paneId) ?? [])];
		},
	};
	return world;
}

/** Read the value of one flag out of an argv. */
function flagValue(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index >= 0 ? args[index + 1] : undefined;
}

/**
 * A 40-hex-digit sha the world mints for its commits and refs. The value
 * never matters to a plane reader; only its shape does.
 */
/** The tree sha beside one commit sha, the way `^{tree}` resolves it. */
function treeShaFor(sha: string): string {
	return `tree-${sha.slice(0, 32)}`;
}

function fakeSha(seed: number): string {
	const digits = "0123456789abcdef";
	let value = "";
	let n = seed >>> 0;
	for (let i = 0; i < 40; i += 1) {
		n = (Math.imul(n, 1103515245) + 12345) & 0x7fffffff;
		value += digits[n % 16];
	}
	return value;
}
