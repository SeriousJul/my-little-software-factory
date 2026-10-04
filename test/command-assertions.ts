/**
 * The shared "this run did not issue that command" assertion.
 *
 * A negated `toContain` fed `expect.stringContaining` can never fail. Bun's
 * `toContain` compares by equality, so an asymmetric matcher passed to it
 * matches no element, so its negation passes whatever the list holds. Every
 * keep-half claim of the start's residue contract (issue #204, stories 7 and
 * 22) - "the workspace that pre-dates the attempt stands", "no branch delete
 * runs for a branch this start did not make" - was written that way, so the
 * suite reported green while the rule it claims to hold was broken.
 *
 * The claim goes through this one helper instead. `test/assertion-architecture.test.ts`
 * refuses the vacuous form anywhere under `test`, and its own test proves this
 * helper can fail, so a guard cannot rot into the thing it replaced.
 */

import { expect } from "bun:test";

/**
 * Fail when any recorded command contains `needle`. `commands` is a fake
 * runner's recorded argv list, one space-joined string per command.
 */
export function expectNoCommand(commands: readonly string[], needle: string): void {
	expect(commands.some((command) => command.includes(needle))).toBe(false);
}
