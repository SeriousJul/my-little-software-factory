/**
 * The stub runner (issue #178, ADR 0073).
 *
 * The seam the Stub run lives on: a command runner that wraps the real child
 * process runner and serves only the `gh` commands from the Stub world.
 * Every other command - `git`, `herdr`, and the agent CLIs - passes to the
 * real binaries untouched, so the handoff, the worktree, and the agent run
 * for real. The startup wiring composes it over the real runner the way the
 * test harness composes its fakes, and no other module in the plane learns
 * that a stub is in play.
 */
import type { CommandRunner } from "../runner.ts";
import type { StubWorldStore } from "./world.ts";

export function createStubRunner(real: CommandRunner, world: StubWorldStore): CommandRunner {
	return {
		run(command, args, options) {
			if (command === "gh") return Promise.resolve(world.answerGh(args));
			return real.run(command, args, options);
		},
		listModels(kind) {
			return real.listModels(kind);
		},
	};
}
