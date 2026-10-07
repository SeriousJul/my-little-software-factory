/**
 * The Ticket list's order across the boot (issue #345).
 *
 * The plane opens on the projection its previous run left in the state file,
 * then reads every configured source. The rows the operator sees must not
 * walk through the list while that first read runs: the boot's own scheduling
 * is not a fact about any Ticket, and a row that moves because a source has
 * not answered yet is the list lying about the work.
 *
 * The rig boots the real app against a real state file that already holds both
 * feeds, and two fake sources whose fetches settle one after the other with
 * the same tickets the state file holds. The walk reads the painted list on
 * every pass of the frame stream and fails on the first order that differs
 * from the order the boot started with.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { FactoryState } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import type { FetchOutcome } from "../src/ticket-source.ts";
import { type AppSetup, listHalfOf, rowsOf, settle, sleep, withApp } from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { emptyAgentRunner } from "./fake-runner.ts";
import { FakeSource } from "./fake-source.ts";
import { callsReached } from "./state-fixture.ts";

let home = "";
const opened: FactoryState[] = [];

beforeEach(() => {
	home = join(tmpdir(), `factory-boot-order-${Math.random().toString(36).slice(2)}`);
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	for (const state of opened.splice(0)) state.close();
	rmSync(home, { recursive: true, force: true });
});

/**
 * Three open Tickets whose numbers interleave across the two feeds: the Issue
 * feed holds #3 and #10, the pull request feed holds #8. The settled list
 * stands them by number, one band: 3, 8, 10. A band split puts the rows of
 * the source that has answered ahead of the row of the source that has not,
 * which is the order 3, 10, 8 the report sees.
 */
const TITLES = new Map<string, string>([
	["github:github.com:I_3", "Alpha task"],
	["github:github.com:I_10", "Bravo task"],
	["github:github.com:P_8", "Charlie branch"],
]);

function issue(number: number): FetchedTicket {
	return {
		identity: `github:github.com:I_${number}`,
		sourceKind: "github-issue",
		externalKey: `#${number}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${number}`,
		title: TITLES.get(`github:github.com:I_${number}`) ?? "",
		description: "The ticket needs work.",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
	};
}

function pullRequest(number: number): FetchedTicket {
	return {
		identity: `github:github.com:P_${number}`,
		sourceKind: "github-pull-request",
		externalKey: `#${number}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/pull/${number}`,
		title: TITLES.get(`github:github.com:P_${number}`) ?? "",
		description: "The branch carries the change.",
		labels: ["ready-for-review"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "https://github.com/acme/factory.git",
		},
		attributes: {},
	};
}

const ISSUE_SNAPSHOT: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [issue(3), issue(10)],
};

const PULL_SNAPSHOT: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [pullRequest(8)],
};

const config: FactoryConfig = {
	...BASE_CONFIG,
	sources: [
		{
			name: "issues",
			kind: "github-issues",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		},
		{
			name: "pulls",
			kind: "github-pull-requests",
			refreshIntervalSeconds: 60,
			repositories: ["acme/factory"],
			host: "github.com",
		},
	],
};

/** The titles the Ticket list holds, top row first. */
function paintedOrder(frame: string): string[] {
	const out: string[] = [];
	for (const row of rowsOf(frame)) {
		const half = listHalfOf(row).replace(/[│┌┐└┘─]/g, " ");
		for (const title of TITLES.values()) if (half.includes(title)) out.push(title);
	}
	return out;
}

describe("the Ticket list's order through the boot", () => {
	test("the first source read does not reorder the list", async () => {
		const state = openFactoryState(join(home, "state.sqlite"));
		opened.push(state);
		// The flat axis: the walk reads the list order itself, with no Group
		// header between the rows.
		state.grouping.setGroupingAxis("tickets", "none");
		// The projection the previous run left: both feeds, healthy, the same
		// three Tickets this run's fetches answer with.
		state.sourceFact.initializeSources([
			{ name: "issues", kind: "github-issues" },
			{ name: "pulls", kind: "github-pull-requests" },
		]);
		state.sourceFact.applyFetch({ name: "issues", kind: "github-issues" }, ISSUE_SNAPSHOT);
		state.sourceFact.applyFetch({ name: "pulls", kind: "github-pull-requests" }, PULL_SNAPSHOT);

		const issues = new FakeSource("issues", "github-issues", ISSUE_SNAPSHOT);
		const pulls = new FakeSource("pulls", "github-pull-requests", PULL_SNAPSHOT);

		await withApp(
			async (setup: AppSetup) => {
				const orders: { at: number; order: string[] }[] = [];
				const started = Date.now();
				const record = () => {
					const order = paintedOrder(setup.captureCharFrame());
					if (order.length === 0) return;
					const last = orders.at(-1);
					if (last === undefined || last.order.join("|") !== order.join("|")) {
						orders.push({ at: Date.now() - started, order });
					}
				};
				// The boot's two fetches settle one after the other, the way two
				// real source reads land seconds apart.
				const fetches = (async () => {
					await callsReached(issues, 1);
					await callsReached(pulls, 1);
					issues.settle(ISSUE_SNAPSHOT);
					await sleep(250);
					pulls.settle(PULL_SNAPSHOT);
				})();
				for (let step = 0; step < 100; step += 1) {
					record();
					await sleep(5);
				}
				await fetches;
				await settle(setup);
				record();

				const settled = orders.at(-1)?.order ?? [];
				expect(settled, `the boot never settled on a list:\n${setup.captureCharFrame()}`).toEqual([
					"Alpha task",
					"Charlie branch",
					"Bravo task",
				]);
				// The symptom: the boot painted one order, so the operator saw no
				// move. Each entry of the sequence is one order the list held, in the
				// order the frames showed them.
				expect(
					orders.map((entry) => entry.order.join(", ")),
					`the Ticket list reordered itself during the boot: ${orders
						.map((entry) => `+${entry.at}ms [${entry.order.join(", ")}]`)
						.join(" then ")}`,
				).toHaveLength(1);
			},
			120,
			30,
			{ config, state, sources: [issues, pulls], runner: emptyAgentRunner(), pollIntervalMs: 5000 },
		);
	});
});
