/**
 * A command runner that holds every command a test names, until the test lets
 * it go.
 *
 * The seat cannot be tested against a timer: the work must stay in flight
 * while the caller queues behind it, and must answer the moment the test says
 * so. A seat test therefore wraps the fake runner in this one, watches
 * `busy()` or `arrivals()` to see the work reach herdr, and `release()`s one
 * held command at a time. The command still answers with what the inner runner
 * holds for it, so a gate changes only when a command returns, never what it
 * returns.
 */
import type { CommandRunner } from "../src/runner.ts";

export interface GatedRunner {
	/** The runner the app or module under test works through. */
	runner: CommandRunner;
	/** Let the oldest held command answer, the way one herdr call finishing does. */
	release: () => void;
	/** True while at least one command waits inside the gate. */
	busy: () => boolean;
	/** How many commands the gate has held so far. */
	arrivals: () => number;
	/** The commands that passed the gate, in arrival order. */
	heldCommands: () => string[];
}

/** Gate every command `matches` until the test releases it. */
export function gatedRunner(
	inner: CommandRunner,
	matches: (command: string) => boolean,
): GatedRunner {
	const waiting: (() => void)[] = [];
	const held: string[] = [];
	let busyCount = 0;
	return {
		runner: {
			run: async (command, args, options) => {
				const name = [command, ...args].join(" ").trim();
				if (matches(name)) {
					held.push(name);
					busyCount += 1;
					await new Promise<void>((resolve) => waiting.push(resolve));
					busyCount -= 1;
				}
				return inner.run(command, args, options);
			},
			listModels: (kind) => inner.listModels(kind),
		},
		release: () => waiting.shift()?.(),
		busy: () => busyCount > 0,
		arrivals: () => held.length,
		heldCommands: () => [...held],
	};
}
