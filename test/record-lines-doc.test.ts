/**
 * The record lines the configuration reference states are the lines the code
 * writes (issue #223 review).
 *
 * The reference page carries about twenty literal record lines: the six holds the
 * automatic walks state, the queue's staging words, every refusal shape, and the
 * two facts the operator sets by key. A page that drifts from the code is worse
 * than no page, because a reviewer greps the file for the words the page taught
 * them. The frame and seam suites already read each line back off the `log` seam;
 * this suite holds the other half - that the page states the same words - and
 * reads the words that live only in a module's source out of that source, so a
 * wording that moves on one side turns this red rather than quietly redefining
 * the guide.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handoffStartFailedLine } from "../src/domain/attempt-record.ts";
import { failedStartParkLine } from "../src/domain/failed-start-park.ts";
import { NAME_COLLISION_PREFIX, nameCollisionLine } from "../src/domain/name-collision.ts";
import { queueStagingOf } from "../src/domain/queue-staging.ts";
import type { AgentNameCollision } from "../src/domain/ticket.ts";
import {
	AUTOMATIC_CANDIDATE_HOLD_REASONS,
	AUTOMATIC_HOLD_LINES,
	AUTOMATIC_ROW_HOLD_REASONS,
	automaticHoldLine,
} from "../src/domain/top-up.ts";

const repo = join(import.meta.dir, "..");
const guide = readFileSync(join(repo, "docs/configuration/index.md"), "utf8");
const appSource = readFileSync(join(repo, "src/components/app.ts"), "utf8");
const dispatchSource = readFileSync(join(repo, "src/handoff-dispatch.ts"), "utf8");
const attemptRecordSource = readFileSync(join(repo, "src/domain/attempt-record.ts"), "utf8");
const failedStartParkSource = readFileSync(join(repo, "src/domain/failed-start-park.ts"), "utf8");
const nameCollisionSource = readFileSync(join(repo, "src/domain/name-collision.ts"), "utf8");

/** One line of the reference page, with the code that writes it named for the failure. */
function statedInGuide(line: string, writtenBy: string): void {
	expect(
		guide.includes(line),
		`${writtenBy} writes ${JSON.stringify(line)}; the guide states it`,
	).toBe(true);
}

/**
 * The value of a module-private string constant, read out of the source that
 * owns it. A missing one fails here, where the reader learns the constant moved,
 * instead of in a doc assertion that would pass on an empty string.
 */
function sourceConstant(source: string, name: string): string {
	const match = new RegExp(`const ${name} = "((?:[^"\\\\]|\\\\.)*)";`).exec(source);
	if (match === null) throw new Error(`${name} is no longer a plain string constant in its module`);
	return match[1];
}

describe("the record lines the configuration reference states", () => {
	test("every automatic-walk hold states its own sentence in the guide", () => {
		// The six sentences come from the module that owns the gates, so a new hold
		// reason has a sentence before it has a line in the file.
		for (const [reason, line] of Object.entries(AUTOMATIC_HOLD_LINES)) {
			statedInGuide(line, `AUTOMATIC_HOLD_LINES[${JSON.stringify(reason)}]`);
		}
	});

	test("every standing-row hold states itself with the row beside it", () => {
		// The page shows the row in parentheses; the builder owns that shape, so the
		// check runs the builder rather than retyping the sentence.
		const examples: Record<string, string> = {
			"continuation-standing": "Persist the source facts",
			"operator-row-standing": "Add a webhook retry policy",
		};
		for (const reason of AUTOMATIC_ROW_HOLD_REASONS) {
			const title = examples[reason];
			if (title === undefined) throw new Error(`${reason} has no example row in this check`);
			statedInGuide(
				automaticHoldLine({ reason, row: "github:github.com:I_5" }, () => `"${title}"`),
				`automaticHoldLine(${JSON.stringify(reason)})`,
			);
		}
	});

	test("every refusal shape the dispatch writes is on the page", () => {
		// One shape for every refusal: the prefix, the ticket's name, and the fact in
		// parentheses. The facts live as constants in the module that refuses, and the
		// page shows each one on the channel that writes it.
		const shapes: Array<{ fact: string; lines: string[] }> = [
			{
				fact: sourceConstant(dispatchSource, "QUEUE_ITEM_STANDS_FACT"),
				lines: [
					'handoff refused: "Add a webhook retry policy"',
					'merge refused: "Persist the source facts"',
				],
			},
			{
				fact: sourceConstant(dispatchSource, "MERGE_RUN_STANDS_FACT"),
				lines: ['merge refused: "Persist the source facts"'],
			},
		];
		for (const shape of shapes) {
			for (const line of shape.lines) {
				statedInGuide(`${line} (${shape.fact})`, `the refusal line for ${shape.fact}`);
			}
		}
	});

	/**
	 * The line a start that reached no Agent leaves (issue #295). It wears the
	 * refusal's shape under its own prefix, and the page has to state both the
	 * prefix and the reason shape, or a reviewer greps the file for words the page
	 * never taught them.
	 */
	test("a start that reached no Agent states its own line in the guide", () => {
		// The sentence lives in the module that owns it, so the check runs the
		// builder instead of retyping it. The two examples are the two endings a
		// reader has to tell from a gate refusal: a start herdr refused, and a
		// start whose Ticket moved on behind it.
		const examples: Array<[string, string]> = [
			['"Add a webhook retry policy"', "the worktree path already exists"],
			['"Watch agent turns"', "the ticket is now closed"],
		];
		for (const [name, fact] of examples) {
			statedInGuide(
				handoffStartFailedLine(name, fact),
				`handoffStartFailedLine(${JSON.stringify(fact)})`,
			);
		}
		// The prefix is the fact that keeps the failed start and the gate refusal
		// apart, so the check reads it out of the module that states it.
		statedInGuide(
			`\`${sourceConstant(attemptRecordSource, "HANDOFF_START_FAILED_PREFIX")}\``,
			"HANDOFF_START_FAILED_PREFIX",
		);
		// And the page says the two lines never answer for one another.
		statedInGuide("`handoff refused:`", "the gate refusal the failed start is told from");
	});

	test("the parked Ticket's hold names the Ticket, and the park states its own line", () => {
		// The Failed-start park stands on one Ticket the walk reached (issue #298), so
		// its hold names that Ticket the way a standing row names its row, and its
		// Message-line fact carries the run it stands on. Both sentences come from the
		// module that owns them, so the checks run the builders.
		for (const reason of AUTOMATIC_CANDIDATE_HOLD_REASONS) {
			statedInGuide(
				automaticHoldLine(
					{ reason, candidate: "github:github.com:I_5" },
					() => `"Watch agent turns"`,
				),
				`automaticHoldLine(${JSON.stringify(reason)})`,
			);
		}
		statedInGuide(
			failedStartParkLine('"Watch agent turns"', 6),
			'failedStartParkLine("Watch agent turns", 6)',
		);
		// The prefix is the fact that keeps the park apart from the walk's other
		// holds, so the check reads it out of the module that states it.
		statedInGuide(
			`\`${sourceConstant(failedStartParkSource, "FAILED_START_PARK_PREFIX")}\``,
			"FAILED_START_PARK_PREFIX",
		);
	});

	test("the held Agent name states its own lines in the guide (issue #299)", () => {
		// The collision is the second standing fact the same ask meets, and its
		// Message line names where the name is held - the whole pointer, because the
		// plane owns no cleanup for the pane. Both sentences come from the module that
		// owns them, so the checks run the builders.
		const refusal =
			"the herdr name watch-agent-turns-1a2b3c4d is held by pane w13K:p1 in workspace w13K, " +
			"which is no agent of this ticket: agent_name_taken";
		const collision: AgentNameCollision = {
			heldName: "watch-agent-turns-1a2b3c4d",
			holderPaneId: "w13K:p1",
			holderWorkspaceId: "w13K",
			reason: refusal,
			at: "2026-10-04T09:12:00Z",
		};
		statedInGuide(
			nameCollisionLine('"Watch agent turns"', collision),
			'nameCollisionLine("Watch agent turns")',
		);
		statedInGuide(
			`\`${sourceConstant(nameCollisionSource, "NAME_COLLISION_PREFIX")}\``,
			"NAME_COLLISION_PREFIX",
		);
		// The record line carries the refusal the attempt's own row stores beside the
		// Ticket, so the row, the detail, and the file name one refusal. The builder
		// owns that shape, so the check runs the builder.
		statedInGuide(
			automaticHoldLine(
				{ reason: "agent-name-held", candidate: "github:github.com:I_5", detail: refusal },
				() => `"Watch agent turns"`,
			),
			"automaticHoldLine(agent-name-held with the refusal beside the Ticket)",
		);
		// And the page says the two facts the same lane carries never answer for one
		// another.
		statedInGuide("`leftover`", "the Leftover environment fact the collision is told from");
		expect(NAME_COLLISION_PREFIX).toBe("agent name held:");
	});

	test("the two facts the operator sets by key state themselves in the guide", () => {
		// These lines have no module of their own: the App writes them at the key. The
		// source text is the code side of the check, so a wording that moves in the App
		// turns this red beside the frame test that reads the line back. Each needle is
		// the literal part of the line the App builds.
		const keyFactLines: Array<{ code: string; guide: string }> = [
			{ code: "mode: auto-handoff is ", guide: "mode: auto-handoff is on" },
			{ code: "mode: auto-handoff is ", guide: "mode: auto-handoff is off" },
			{
				code: '"queue: the Work queue is paused"',
				guide: "queue: the Work queue is paused",
			},
			{
				code: '"queue: the Work queue resumed"',
				guide: "queue: the Work queue resumed",
			},
			{
				code: "queue: the Work queue pause did not move: ",
				guide: "queue: the Work queue pause did not move:",
			},
			{
				code: " for this session only: the plane runs with no state file",
				guide: "for this session only: the plane runs with no state file",
			},
		];
		for (const { code, guide: line } of keyFactLines) {
			expect(
				appSource.includes(code),
				`the App no longer writes its key line in the shape this check reads: ${code}`,
			).toBe(true);
			statedInGuide(line, "the App's key line");
		}
	});

	test("the queue's lines name the staging the guide explains", () => {
		// The two staging words the queue's four lines read, each shown in the page's
		// examples beside the other staging on the same line, so a reader sees the
		// pair rather than one word and a sentence about the other.
		const examples: Array<{ staging: boolean; queued: string; started: string }> = [
			{
				staging: false,
				queued: 'handoff queued: "Add a webhook retry policy"',
				started: 'handoff started: "Watch agent turns"',
			},
			{
				staging: true,
				queued: 'handoff queued: "Watch agent turns"',
				started: 'handoff started: "Add a webhook retry policy"',
			},
		];
		for (const example of examples) {
			const staging = queueStagingOf(example.staging);
			statedInGuide(`${example.queued} (origin open, ${staging})`, "the queued line");
			statedInGuide(
				`${example.started} (mode pickup, origin open, ${staging}, seats 1/2)`,
				"the start line",
			);
		}
	});
});
