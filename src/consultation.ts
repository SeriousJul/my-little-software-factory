/** Shared Consultation rules which do not depend on the TUI. */
import type { FactoryConfig } from "./config.ts";
import type { RepositoryRef, Ticket } from "./domain/ticket.ts";
import { fileExists } from "./fs.ts";
import type { HerdrAgent } from "./observation.ts";
import { expandHome, matchesRepository, realPathOf } from "./repo.ts";
import type { CommandResult, CommandRunner } from "./runner.ts";
import type { Consultation, ConsultationResource } from "./state.ts";

export const CONSULTATION_INPUT_LIMIT = 64 * 1024;
export const CONSULTATION_SNAPSHOT_LIMIT = 1024 * 1024;

/** Serialize topology and cleanup work per Repository without blocking others. */
export function serializeRepositoryOperation<T>(
	queues: Map<string, Promise<void>>,
	repositoryIdentity: string,
	operation: () => Promise<T>,
): Promise<T> {
	const normalized = repositoryIdentity.toLowerCase();
	const key =
		normalized === ""
			? normalized
			: normalized.startsWith("github.com/")
				? normalized
				: `github.com/${normalized}`;
	const previous = queues.get(key) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(operation);
	const finished = current.then(
		() => undefined,
		() => undefined,
	);
	queues.set(key, finished);
	void finished.then(() => {
		if (queues.get(key) === finished) queues.delete(key);
	});
	return current;
}

/** Return the UTF-8 size of operator input. */
export function utf8ByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** Validate input without changing it, so an oversized draft stays editable. */
export function validateConsultationInput(
	value: string,
	limit = CONSULTATION_INPUT_LIMIT,
): string | undefined {
	if (value.trim() === "") return "initial input cannot be empty";
	const bytes = utf8ByteLength(value);
	if (bytes > limit) return `initial input is ${bytes} UTF-8 bytes; the limit is ${limit}`;
	return undefined;
}

/** The bounded prompt argument used by normal Consultation responses. */
export function validateResponseInput(
	value: string,
	limit = CONSULTATION_INPUT_LIMIT,
): string | undefined {
	if (value.trim() === "") return "response cannot be empty";
	const bytes = utf8ByteLength(value);
	return bytes > limit ? `response is ${bytes} UTF-8 bytes; the limit is ${limit}` : undefined;
}

/** A Repository catalog contains only known identities and configured paths. */
export interface ConsultationRepositoryOption extends RepositoryRef {
	path: string;
}

export function consultationRepositoryCatalog(
	config: FactoryConfig,
	tickets: readonly Pick<Ticket, "repositoryRef">[] = [],
): ConsultationRepositoryOption[] {
	const options = new Map<string, ConsultationRepositoryOption>();
	for (const [identity, path] of Object.entries(config.repos)) {
		const normalized = identity.toLowerCase().startsWith("github.com/")
			? identity
			: `github.com/${identity}`;
		const displayName = normalized.slice("github.com/".length);
		options.set(normalized.toLowerCase(), {
			identity: normalized.toLowerCase(),
			displayName,
			cloneUrl: `https://github.com/${displayName}.git`,
			path,
		});
	}
	for (const ticket of tickets) {
		const ref = ticket.repositoryRef;
		const key = ref.identity.toLowerCase();
		if (!options.has(key) && ticket.repositoryRef.identity !== "") {
			const shortIdentity = key.startsWith("github.com/") ? key.slice("github.com/".length) : key;
			options.set(key, {
				...ref,
				identity: key,
				path: config.repos[key] ?? config.repos[shortIdentity] ?? "",
			});
		}
	}
	return [...options.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Verify explicit launcher mappings before showing them. A visible Ticket
 * Repository without a mapping remains eligible: launch resolves it through
 * the normal convention and sibling-clone rules.
 */
export async function validateConsultationRepositoryOptions(
	options: readonly ConsultationRepositoryOption[],
	runner: CommandRunner,
	home: string,
): Promise<ConsultationRepositoryOption[]> {
	const verified = await Promise.all(
		options.map(async (option) => {
			// An empty path means this identity came from a visible Ticket. It is
			// not an unchecked path. The serialized launch resolves it normally.
			if (option.path === "") return option;
			const path = expandHome(option.path, home);
			if (!(await fileExists(path))) return undefined;
			const git = await runner.run("git", ["-C", path, "rev-parse", "--git-dir"]);
			if (git.code !== 0) return undefined;
			const remote = await runner.run("git", ["-C", path, "remote", "get-url", "origin"]);
			if (remote.code !== 0 || !matchesRepository(remote.stdout.trim() || null, option.identity))
				return undefined;
			return { ...option, path: await realPathOf(path) };
		}),
	);
	return verified.filter((option): option is ConsultationRepositoryOption => option !== undefined);
}

/** A safety fact shown before a live-worktree launch. */
export interface LiveCheckoutSafety {
	dirty: boolean;
	warning?: string;
	conflicts: CheckoutConflict[];
}

export interface CheckoutConflict {
	kind: "ticket" | "consultation" | "herdr-agent";
	identity: string;
	label: string;
}

/**
 * Check a live checkout without making changes. The caller decides whether a
 * conflict gets a one-shot override. Dirty state is a warning, not a block.
 */
export async function inspectLiveCheckout(
	checkout: string,
	runner: CommandRunner,
	tickets: readonly Ticket[],
	consultations: readonly Consultation[],
	agents: readonly HerdrAgent[],
): Promise<LiveCheckoutSafety> {
	if (!(await fileExists(checkout))) return { dirty: false, conflicts: [] };
	const status = await runner.run("git", [
		"-C",
		checkout,
		"status",
		"--porcelain",
		"--untracked-files=all",
	]);
	if (status.code !== 0)
		throw new Error(
			`cannot inspect live checkout: ${status.stderr.trim() || `exit code ${status.code}`}`,
		);
	const dirty = status.stdout.trim() !== "";
	const conflicts: CheckoutConflict[] = [];
	const target = await realPathOf(checkout);
	// Ticket conflicts compare the resolved checkout, not the repository
	// identity: a worktree handoff of the same repository does not share
	// this live checkout, and a different mapping of the same repository
	// does.
	for (const ticket of tickets) {
		if (ticket.handoff === null || (ticket.state !== "handed-off" && ticket.state !== "running"))
			continue;
		if (ticket.handoff.paneId === null) continue;
		const agent = agents.find((candidate) => candidate.paneId === ticket.handoff?.paneId);
		if (agent === undefined) continue;
		const agentCheckout =
			agent.checkoutPath === undefined ? null : await realPathOf(agent.checkoutPath);
		if (agentCheckout !== null) {
			if (agentCheckout !== target) continue;
		} else if (ticket.handoff.environment !== "live-worktree") continue;
		// An unknown checkout of a live-worktree handoff cannot be proven
		// separate: keep it a conflict instead of sharing a shared checkout.
		conflicts.push({
			kind: "ticket",
			identity: ticket.identity,
			label: `Ticket ${ticket.identity}`,
		});
	}
	for (const consultation of consultations) {
		if (
			consultation.state !== "working" &&
			consultation.state !== "opening" &&
			consultation.state !== "awaiting-response"
		)
			continue;
		if (
			consultation.repository.path !== checkout &&
			(await realPathOf(consultation.repository.path)) !== target
		)
			continue;
		if (
			consultation.paneId !== null &&
			agents.some((agent) => agent.paneId === consultation.paneId)
		)
			conflicts.push({
				kind: "consultation",
				identity: consultation.id,
				label: `Consultation ${consultation.id.slice(0, 8)}`,
			});
	}
	for (const agent of agents) {
		if (agent.checkoutPath === undefined || (await realPathOf(agent.checkoutPath)) !== target)
			continue;
		conflicts.push({
			kind: "herdr-agent",
			identity: agent.paneId,
			label: `Herdr Agent ${agent.agent} (${agent.paneId})`,
		});
	}
	return {
		dirty,
		...(dirty ? { warning: "the live checkout has uncommitted changes" } : {}),
		conflicts: uniqueConflicts(conflicts),
	};
}

/** Printable text may include pasted newlines and tabs, but no terminal controls. */
export function isLiteralText(value: string): boolean {
	return [...value].every(
		(character) => character === "\n" || character === "\t" || !/\p{Cc}/u.test(character),
	);
}

function uniqueConflicts(conflicts: readonly CheckoutConflict[]): CheckoutConflict[] {
	const seen = new Set<string>();
	return conflicts.filter((conflict) => {
		const key = `${conflict.kind}:${conflict.identity}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Build recovery context with original input and newest turns first. */
export function boundedReplacementInput(
	originalInput: string,
	turns: readonly { input: string; output?: string }[],
	limit = CONSULTATION_INPUT_LIMIT,
): string {
	const sections = [`Original input:\n${originalInput}`];
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		const turn = turns[index];
		sections.push(
			`Operator response:\n${turn.input}${turn.output === undefined ? "" : `\nAgent output:\n${turn.output}`}`,
		);
	}
	const full = sections.join("\n\n");
	if (utf8ByteLength(full) <= limit) return full;
	const marker = "\n\n[recovery context omitted]\n";
	if (limit <= utf8ByteLength(marker)) return utf8Prefix(marker, limit);
	return `${utf8Prefix(full, limit - utf8ByteLength(marker))}${marker}`;
}

function utf8Prefix(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	let prefix = bytes.subarray(0, maxBytes).toString("utf8");
	while (utf8ByteLength(prefix) > maxBytes) prefix = prefix.slice(0, -1);
	return prefix;
}

/** Semantic input events accepted by Agent interaction mode. */
export type AgentKeyName =
	| "up"
	| "down"
	| "left"
	| "right"
	| "enter"
	| "escape"
	| "backspace"
	| "tab"
	| "home"
	| "end"
	| "pageup"
	| "pagedown"
	| `f${number}`
	| `ctrl+${string}`;
export type AgentInputEvent = { kind: "text"; text: string } | { kind: "key"; key: AgentKeyName };

/** Convert an outer key event to literal text or a semantic pane key. */
export function translateAgentKey(
	key: { name: string; sequence?: string; ctrl?: boolean; meta?: boolean; shift?: boolean },
	exitKey: string,
): AgentInputEvent | null {
	const name = key.name.toLowerCase();
	const normalizedExit = exitKey.toLowerCase().replace(/^ctrl-/, "ctrl+");
	if (name === normalizedExit || (normalizedExit === `ctrl+${name}` && key.ctrl === true))
		return null;
	// AltGr is reported as Meta by some layouts but still carries literal
	// Unicode text. Preserve that text instead of turning it into a US key.
	if (key.meta && !key.ctrl && isLiteralText(key.name) && key.name.length > 0)
		return { kind: "text", text: name === "space" ? " " : key.name };
	if (key.ctrl || key.meta) {
		if (name.length === 1 && /[a-z]/.test(name)) return { kind: "key", key: `ctrl+${name}` };
		return null;
	}
	const semantic = new Set([
		"up",
		"down",
		"left",
		"right",
		"return",
		"enter",
		"escape",
		"backspace",
		"tab",
		"home",
		"end",
		"pageup",
		"pagedown",
	]);
	if (semantic.has(name))
		return { kind: "key", key: (name === "return" ? "enter" : name) as AgentKeyName };
	if (/^f\d+$/.test(name)) return { kind: "key", key: name as AgentKeyName };
	if ([...key.name].length > 0 && isLiteralText(key.name))
		return { kind: "text", text: name === "space" ? " " : key.name };
	return null;
}

/**
 * Queue Agent interaction input in terminal order.
 *
 * Literal text is batched up to a fixed UTF-8 bound. A semantic key flushes
 * all preceding text before it enters the queue, so an Enter or control key
 * can never overtake pasted Unicode text.
 */
export class ConsultationInputQueue {
	private readonly runner: CommandRunner;
	private readonly textBatchBytes: number;
	private tail: Promise<void> = Promise.resolve();
	private pendingText = "";
	private pendingPaneId: string | null = null;
	private pendingResolvers: Array<{
		resolve: (result: CommandResult) => void;
		reject: (reason: unknown) => void;
	}> = [];
	private flushScheduled = false;

	constructor(runner: CommandRunner, textBatchBytes = 4096) {
		this.runner = runner;
		this.textBatchBytes = textBatchBytes;
	}

	enqueue(paneId: string, event: AgentInputEvent): Promise<CommandResult> {
		if (event.kind === "key") {
			this.flushText();
			return this.enqueueCommand(["pane", "send-keys", paneId, event.key]);
		}
		if (event.text === "") return Promise.resolve({ code: 0, stdout: "", stderr: "" });
		if (this.pendingPaneId !== null && this.pendingPaneId !== paneId) this.flushText();
		this.pendingPaneId = paneId;
		const promise = new Promise<CommandResult>((resolve, reject) => {
			this.pendingResolvers.push({ resolve, reject });
		});
		this.pendingText += event.text;
		if (!this.flushScheduled) {
			this.flushScheduled = true;
			queueMicrotask(() => {
				this.flushScheduled = false;
				this.flushText();
			});
		}
		return promise;
	}

	/** Flush buffered text and wait until every queued input settles. */
	async flush(): Promise<void> {
		this.flushText();
		await this.tail;
	}

	private flushText(): void {
		if (this.pendingText === "") return;
		const text = this.pendingText;
		const paneId = this.pendingPaneId;
		const resolvers = this.pendingResolvers;
		this.pendingText = "";
		this.pendingPaneId = null;
		this.pendingResolvers = [];
		if (paneId === null) return;
		let last: Promise<CommandResult> | undefined;
		for (const chunk of utf8Chunks(text, this.textBatchBytes))
			last = this.enqueueCommand(["pane", "send-text", paneId, chunk]);
		if (last === undefined) return;
		void last.then(
			(result) => {
				resolvers.forEach(({ resolve }) => {
					resolve(result);
				});
			},
			(error) => {
				resolvers.forEach(({ reject }) => {
					reject(error);
				});
			},
		);
	}

	private enqueueCommand(args: string[]): Promise<CommandResult> {
		const run = this.tail.then(() => this.runner.run("herdr", args));
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

function utf8Chunks(text: string, limit: number): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const character of text) {
		if (current !== "" && utf8ByteLength(current) + utf8ByteLength(character) > limit) {
			chunks.push(current);
			current = character;
		} else current += character;
	}
	if (current !== "") chunks.push(current);
	return chunks;
}

/** A resource fact which belongs to a Consultation and can be retried safely. */
export function unconfirmedOwnedResources(
	resources: readonly ConsultationResource[],
): ConsultationResource[] {
	return resources.filter((resource) => resource.owned && !resource.confirmedClosed);
}

/** A remote URL check kept here for callers resolving a Repository option. */
export function repositoryMatchesCheckout(remote: string | null, identity: string): boolean {
	return matchesRepository(remote, identity);
}
