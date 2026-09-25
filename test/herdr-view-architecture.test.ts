/**
 * The control plane never moves herdr's view on its own (ADR 0061).
 *
 * A close that takes an environment down used to follow herdr with a
 * `workspace focus` back to the plane, and the operator lost their place
 * twice for a bookkeeping act they cannot see. ADR 0061 retires that
 * compensating call: herdr keeps each client's own view, and a close of a
 * workspace the client is not viewing leaves that view alone. The one focus
 * move the plane makes is Goto, at the operator's key.
 *
 * The rule is a declared dependency rule, and it is not a behavior test: what
 * the operator sees is checked by `test/herdr-view-frame.test.ts`, which
 * drives the real screens and reads the commands that leave the plane. This
 * file refuses the shape a new screen would take to re-add the move, so the
 * rule cannot be restored unnoticed, the way the shared-control library check
 * refuses a screen-built field.
 *
 * Two known limits of the create scan, stated so no reader trusts more than
 * it holds: an argv a function assembles and returns is not read at all, and
 * a runner call that receives the argv under another name is not matched, so
 * such a create passes without its flag being seen. The frame seam owns those
 * shapes; a new file that hides a create in either shape is not caught here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sourceFiles } from "./static-checks.ts";

const sources = sourceFiles("src");

/** The argv shape of a herdr focus request, however the args are assembled. */
const WORKSPACE_FOCUS = /"workspace"\s*,\s*"focus"/u;
const TAB_FOCUS = /"tab"\s*,\s*"focus"/u;
const PANE_FOCUS = /"pane"\s*,\s*"focus"/u;
const AGENT_FOCUS = /"agent"\s*,\s*"focus"/u;

describe("the plane sends herdr no workspace focus", () => {
	test("the scan reads the plane's own sources", () => {
		// A check that scans nothing passes forever. The three surfaces the
		// rule touches must be in the set the scan reads.
		for (const required of [
			"src/handoff.ts",
			"src/handoff-dispatch.ts",
			"src/consultation-operations.ts",
			"src/components/app.ts",
		]) {
			expect(sources, `${required} must be in the scanned set`).toContain(required);
		}
	});

	test("no source asks herdr for a workspace focus", () => {
		// The retired compensating call, and any new one: a workspace focus is
		// how the plane would drag the operator's view back to itself.
		const offenders = sources.filter((file) => WORKSPACE_FOCUS.test(readFileSync(file, "utf8")));
		expect(offenders).toEqual([]);
	});

	test("no source asks herdr for a tab or a pane focus", () => {
		// The same move through the other containers. The plane navigates to an
		// Agent's pane, never to a tab or a bare pane, so neither belongs in it.
		const offenders = sources.filter((file) => {
			const source = readFileSync(file, "utf8");
			return TAB_FOCUS.test(source) || PANE_FOCUS.test(source);
		});
		expect(offenders).toEqual([]);
	});

	test("an Agent focus stands only at the Goto seam", () => {
		// Goto is the rule's one exception (ADR 0033, ADR 0061): it runs at the
		// operator's key in the Ticket and Consultation sections, the Decision
		// screen, and the Live view, and all three cross the one seam in
		// `src/components/app.ts`. A second file that asks for an Agent focus
		// aims herdr's view without an operator's key behind it.
		const offenders = sources.filter(
			(file) => AGENT_FOCUS.test(readFileSync(file, "utf8")) && file !== "src/components/app.ts",
		);
		expect(offenders).toEqual([]);
	});

	test("the plane holds no id for the workspace it runs in", () => {
		// Story 12: with no control-plane workspace id in the plane, no code
		// path can aim herdr's focus at it again. The herdr environment mark
		// stays for the Theme inheritance; only the id leaves.
		const offenders = sources.filter((file) => {
			const source = readFileSync(file, "utf8");
			return (
				/HERDR_WORKSPACE_ID/u.test(source) ||
				/controlPlaneWorkspaceId/u.test(source) ||
				/CONTROL_PLANE_WORKSPACE_ID/u.test(source)
			);
		});
		expect(offenders).toEqual([]);
	});

	test("every herdr create states its no-focus default", () => {
		// herdr's changelog records that the create-focus default regressed once
		// (#3766, fixed in v0.9.1), so the flag is a contract, not noise. Each
		// create argv is read on its own: the array literal that names a herdr
		// create must carry `--no-focus` inside it, or the variable it is assigned
		// to must be pushed the flag before the runner call. A file that says
		// `--no-focus` once and creates elsewhere is exactly the drift this refuses.
		const offenders: string[] = [];
		for (const file of sources) {
			const source = readFileSync(file, "utf8");
			for (const match of source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(\[[^\]]*\])/gsu)) {
				const [, variable, literal] = match;
				if (!/"(?:workspace|tab|worktree)"\s*,\s*"(?:create|open)"/u.test(literal)) continue;
				if (/--no-focus/u.test(literal)) continue;
				// The assembled argv: the flag must be pushed onto the same
				// variable after its declaration and before the first runner
				// call that carries it, so a push written after the call, or
				// beside a different same-named argv, cannot pass. A create the
				// check cannot read at all - an argv a function assembles and
				// returns, or a call that passes the argv under another name -
				// stays outside this scan; the frame seam owns those shapes.
				const declared = source.slice(match.index ?? 0);
				const push = new RegExp(`${variable}\\.push\\(\\s*"--no-focus"`, "u").exec(declared);
				const call = new RegExp(`run\\(\\s*"herdr"\\s*,\\s*${variable}\\b`, "u").exec(declared);
				if (push !== null && (call === null || push.index < call.index)) continue;
				offenders.push(`${file}: ${variable}`);
			}
			// A create argv written inline, with no variable to push onto, must
			// carry the flag in the literal itself.
			for (const match of source.matchAll(/run\(\s*"herdr"\s*,\s*(\[[^\]]*\])/gsu)) {
				const [, literal] = match;
				if (!/"(?:workspace|tab|worktree)"\s*,\s*"(?:create|open)"/u.test(literal)) continue;
				if (!/--no-focus/u.test(literal)) offenders.push(`${file}: inline create argv`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
