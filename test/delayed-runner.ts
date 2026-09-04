/**
 * A command runner that delays its first calls, so an in-flight state is
 * visible. `callsToDelay` defaults to one; pass `Number.POSITIVE_INFINITY`
 * to delay every call.
 */
import type { CommandResult, CommandRunner, ModelListResult } from "../src/runner.ts";

export class DelayedRunner implements CommandRunner {
	private remaining: number;
	private inner: CommandRunner;
	private delayMs: number;

	constructor(inner: CommandRunner, delayMs: number, callsToDelay = 1) {
		this.inner = inner;
		this.delayMs = delayMs;
		this.remaining = callsToDelay;
	}

	run(command: string, args: string[]): Promise<CommandResult> {
		if (this.remaining <= 0) {
			return this.inner.run(command, args);
		}
		this.remaining -= 1;
		return new Promise((resolve) =>
			setTimeout(() => resolve(this.inner.run(command, args)), this.delayMs),
		);
	}

	/** The Model list query is not the delayed work: it passes straight through. */
	listModels(kind: string): Promise<ModelListResult> {
		return this.inner.listModels(kind);
	}
}
