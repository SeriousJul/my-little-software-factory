/**
 * Tests for the Default configuration the plane ships.
 *
 * The file is imported as a file (src/shipped-default.ts): the read that
 * seeds a missing config file must reach the same bytes in a source run and
 * in a compiled binary, where the module's own directory is a virtual path
 * that holds code only. The compiled read is exercised by the release
 * build's smoke steps; here the source-run read is pinned to the checked-in
 * file, so the two cannot drift.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

import { validateConfig } from "../src/config.ts";
import type { SourceMembership } from "../src/domain/ticket.ts";
import { openTicketRowGate } from "../src/domain/top-up.ts";
import { readShippedDefaultConfigText, shippedDefaultConfigPath } from "../src/shipped-default.ts";
import { selectTaskType } from "../src/task-selection.ts";

/** The checked-in Default configuration. */
const CHECKED_IN = fileURLToPath(new URL("../config/default.toml", import.meta.url));

describe("the shipped Default configuration", () => {
	test("the path resolves to the checked-in file in a source run", () => {
		expect(shippedDefaultConfigPath()).toBe(CHECKED_IN);
	});

	test("the read returns the checked-in file's text, verbatim", async () => {
		expect(await readShippedDefaultConfigText()).toBe(readFileSync(CHECKED_IN, "utf8"));
	});

	test("the shipped text validates, so a first run always seeds a usable config", async () => {
		const config = validateConfig(parse(await readShippedDefaultConfigText()));
		expect(config.defaultAgent).toBe("pi");
		expect(config.defaultEnvironment).toBe("worktree");
	});
});

/**
 * The candidate decision of the shipped machine (issue #396).
 *
 * The regression stands on the shipped bytes, not on a copy of the states:
 * the read is the one that seeds a missing Config file, and the decision is
 * the machine's one match walk - the same read the projection and the
 * fresh-work walk share - with the walk's row gate on the task it answers.
 * A ticket without `ready-for-agent` must not be a candidate to `implement`:
 * in the shipped machine the issue states are the label gates, and an issue
 * none of them claims rests on the issue park and offers no task.
 */
describe("the shipped machine holds a ticket without ready-for-agent off implement", () => {
	const config = validateConfig(parse(readFileSync(CHECKED_IN, "utf8")));

	function membership(
		sourceKind: SourceMembership["sourceKind"],
		labels: string[],
	): SourceMembership {
		return {
			sourceName: sourceKind === "github-issue" ? "issues" : "pulls",
			health: "healthy",
			identity: `github:github.com:${sourceKind}-1`,
			sourceKind,
			externalKey: "#1",
			sourceState: "open",
			url: `https://github.com/acme/factory/${sourceKind}-1`,
			title: "a fresh ticket",
			description: "",
			labels,
			externalUpdatedAt: "2026-08-31T11:00:00Z",
			repository: {
				identity: "github.com/acme/factory",
				displayName: "acme/factory",
				cloneUrl: "https://github.com/acme/factory.git",
			},
			attributes: {},
		};
	}

	/** The task the machine offers, and the fresh-work walk's answer on it. */
	function candidate(
		sourceKind: SourceMembership["sourceKind"],
		labels: string[],
	): { suggested: string | null; stands: boolean } {
		const suggested = selectTaskType(
			[membership(sourceKind, labels)],
			config.workflowStates,
			config.defaultTaskType,
		);
		const gate = openTicketRowGate({
			state: "open",
			actionable: true,
			ignoreBlocked: false,
			handoffCount: 0,
			handoffLimit: config.maxHandoffsPerTicket,
			taskType: suggested,
			operatorDecides:
				suggested === null ? false : config.taskTypes[suggested]?.operatorDecides === true,
		});
		return { suggested, stands: gate.stands === true };
	}

	test("an issue without a workflow label offers no task and is no candidate for implement", () => {
		const { suggested, stands } = candidate("github-issue", []);
		expect(suggested).toBeNull();
		expect(stands).toBe(false);
	});

	test("an issue the operator scoped but did not place offers no task either", () => {
		const { suggested, stands } = candidate("github-issue", ["factory"]);
		expect(suggested).toBeNull();
		expect(stands).toBe(false);
	});

	test("an issue with ready-for-agent stays the implement candidate the machine offers", () => {
		const { suggested, stands } = candidate("github-issue", ["ready-for-agent"]);
		expect(suggested).toBe("implement");
		expect(stands).toBe(true);
	});

	test("an issue with ready-for-spec or bug keeps its own position, and the walk holds it for its flag", () => {
		expect(candidate("github-issue", ["ready-for-spec"]).suggested).toBe("analyze");
		expect(candidate("github-issue", ["bug"]).suggested).toBe("diagnose");
		// Both types carry the Operator-decides flag: the walk holds them in
		// their designed silence, the label gates themselves stand.
		expect(candidate("github-issue", ["ready-for-spec"]).stands).toBe(false);
		expect(candidate("github-issue", ["bug"]).stands).toBe(false);
	});

	test("a ticket with ready-for-agent and ready-for-spec alike rests at ready-for-agent", () => {
		const { suggested, stands } = candidate("github-issue", ["ready-for-agent", "ready-for-spec"]);
		expect(suggested).toBe("implement");
		expect(stands).toBe(true);
	});

	test("the pull request park stands unchanged beside the issue park", () => {
		const { suggested, stands } = candidate("github-pull-request", []);
		expect(suggested).toBeNull();
		expect(stands).toBe(false);
	});
});
