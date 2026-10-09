/**
 * The Agent input module: how keystrokes reach an Agent terminal.
 *
 * Agent interaction mode forwards the operator's input to the Agent's pane.
 * This module owns the key translation - the semantic keys, the AltGr text, and
 * the exit key that stays the exit key - and the ordered input queue with its
 * text batching bound. It takes the literal-text rule from the Response draft
 * module instead of holding a second copy, so the plane's two paths that refuse
 * terminal control bytes read one owner. The shared field's paste path is a
 * third path with its own owner, `stripAnsiSequences` from `@opentui/core`
 * (issue #203, ADR 0096).
 */

import type { CommandResult, CommandRunner } from "../runner.ts";
import { utf8ByteLength } from "../text-bounds.ts";
import { isLiteralText } from "./response-draft.ts";

/** The UTF-8 bound one batch of consecutive literal text may reach the Agent in. */
const TEXT_BATCH_BYTES = 4096;

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
	if (key.meta && !key.ctrl) {
		const text = literalTextOf(name, key.name);
		if (text !== null) return { kind: "text", text };
	}
	if (key.ctrl || key.meta) {
		return singleLetterControlKey(name);
	}
	const semantic = semanticKeyName(name);
	if (semantic !== null) return { kind: "key", key: semantic };
	const text = literalTextOf(name, key.name);
	if (text !== null) return { kind: "text", text };
	return null;
}

/** The semantic key one outer key name carries, if it carries one. */
function semanticKeyName(name: string): AgentKeyName | null {
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
	if (semantic.has(name)) return (name === "return" ? "enter" : name) as AgentKeyName;
	if (/^f\d+$/.test(name)) return name as AgentKeyName;
	return null;
}

/** The literal text one outer key name carries, if it carries any. */
function literalTextOf(name: string, raw: string): string | null {
	if ([...raw].length > 0 && isLiteralText(raw)) return name === "space" ? " " : raw;
	return null;
}

/** The control key one single letter names under Ctrl or Meta, if any. */
function singleLetterControlKey(name: string): AgentInputEvent | null {
	if (name.length === 1 && /[a-z]/.test(name)) return { kind: "key", key: `ctrl+${name}` };
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

	constructor(runner: CommandRunner, textBatchBytes = TEXT_BATCH_BYTES) {
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
