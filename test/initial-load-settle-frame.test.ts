import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FetchOutcome } from "../src/ticket-source.ts";
import {
	type AppSetup,
	frameUntil,
	listHalfOf,
	markerRowOf,
	rowsOf,
	settle,
	sleep,
	startingFaceOf,
	withApp,
} from "./app-harness.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { fetchedTicket, fetchSuccess, issueTicket, ticketOf } from "./fact-fixtures.ts";
import { emptyAgentRunner } from "./fake-runner.ts";
import type { FakeSource } from "./fake-source.ts";
import { callsReached, issuesSourceConfig, plane, reopenState, seedInFlightTurn } from "./plane.ts";

/**
 * The plane holds its first probe and its first list move until the
 * initial load settles (issue #431, ADR 0154).
 *
 * The rig boots the real shell on a seeded plane with stub sources: the
 * painted ticket list stands on the state's boot read until every
 * source's first fetch settles, and it moves exactly once after, from
 * the state that stands when the load settles. The plane's first herdr
 * probe lands on the settle, after the sources' boot reads, so it reads
 * the roster the settled sources make, not an empty one. An in-flight
 * ticket wears its state face while the load stands, and the Missing
 * marker appears only when a probe after the settle answers it.
 *
 * The frames paint at a terminal of 120 columns by 30 rows. The width
 * keeps the longest pinned row whole: the list pane holds
 * floor(120 / 2) = 60 columns, and the list's text area holds 60 - 4 =
 * 56, the pane border and one cell of padding on each side. A row reads
 * 2 columns of selection marker, 12 of the state badge or its spinner
 * face, 11 of the task-type badge, 13 of the repository name, and 18 of
 * the title field, 56 exactly, so the longest title, "Charlie branch"
 * (14 columns), stands whole with no truncation; no width below 114
 * keeps it whole. The height gives the list a window of 30 - 4 = 26
 * rows, and the five settled rows stand inside it, none slides out.
 */

const TITLES = new Map<string, string>([
	["github:github.com:I_2", "Eco task"],
	["github:github.com:I_3", "Alpha task"],
	["github:github.com:I_10", "Bravo task"],
	["github:github.com:I_6", "Delta task"],
	["github:github.com:P_4", "Delta branch"],
	["github:github.com:P_8", "Charlie branch"],
]);

const paths: string[] = [];

afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function issue(key: string, title: string): ReturnType<typeof fetchedTicket> {
	return fetchedTicket({
		identity: key,
		sourceKind: "github-issue",
		externalKey: key.split("_").pop() ?? "",
		sourceState: "open",
		url: `https://github.com/acme/factory/issues/${key.split("_").pop() ?? ""}`,
		title,
		description: "The ticket the seeded plane booted on",
		labels: ["ready-for-agent"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "git@github.com:acme/factory.git",
		},
		attributes: {},
	});
}

function pull(key: string, title: string): ReturnType<typeof fetchedTicket> {
	return fetchedTicket({
		identity: key,
		sourceKind: "github-pull-request",
		externalKey: `#${key.split("_").pop() ?? ""}`,
		sourceState: "open",
		url: `https://github.com/acme/factory/pull/${key.split("_").pop() ?? ""}`,
		title,
		description: "The pull the seeded plane booted on",
		labels: ["ready-for-review"],
		externalUpdatedAt: "2026-08-31T10:00:00Z",
		repository: {
			identity: "github.com/acme/factory",
			displayName: "acme/factory",
			cloneUrl: "git@github.com:acme/factory.git",
		},
		attributes: {},
	});
}

const ISSUES_CONFIG = {
	name: "issues",
	kind: "github-issues" as const,
	refreshIntervalSeconds: 60,
	repositories: ["acme/factory"],
	host: "github.com",
};

const PULLS_CONFIG = {
	name: "pulls",
	kind: "github-pull-requests" as const,
	refreshIntervalSeconds: 60,
	repositories: ["acme/factory"],
	host: "github.com",
};

// The state the plane booted on: the issues band first, then the pull.
const BOOT_TICKETS = [
	ticketOf(issue("github:github.com:I_3", TITLES.get("github:github.com:I_3") ?? "")),
	ticketOf(issue("github:github.com:I_10", TITLES.get("github:github.com:I_10") ?? "")),
	ticketOf(pull("github:github.com:P_8", TITLES.get("github:github.com:P_8") ?? "")),
];

// The settled load: both sources answered, and the list stands on the
// state the settled sources and the state it held stand.
const ISSUES_SETTLED: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [
		issue("github:github.com:I_2", TITLES.get("github:github.com:I_2") ?? ""),
		issue("github:github.com:I_3", TITLES.get("github:github.com:I_3") ?? ""),
		issue("github:github.com:I_10", TITLES.get("github:github.com:I_10") ?? ""),
	],
};

const PULLS_SETTLED: FetchOutcome = {
	status: "success",
	fetchedAt: "2026-08-31T10:01:00Z",
	tickets: [
		pull("github:github.com:P_4", TITLES.get("github:github.com:P_4") ?? ""),
		pull("github:github.com:P_8", TITLES.get("github:github.com:P_8") ?? ""),
	],
};

// The orders the painted list stands on, booted and settled: the pin of
// the list's one move on the settle.
const BOOT_ORDER = ["Charlie branch", "Bravo task", "Alpha task"];
const SETTLED_ORDER = ["Delta branch", "Charlie branch", "Bravo task", "Eco task", "Alpha task"];

function settledPlane(fields: { agentHostEnv?: Record<string, string> } = {}) {
	return plane({
		config: {
			...BASE_CONFIG,
			sources: [ISSUES_CONFIG, PULLS_CONFIG],
			maxParallelAgents: 2,
		},
		groupingAxis: "none",
		repos: { "github.com/acme/factory": "checkout" },
		sources: [
			{ config: ISSUES_CONFIG, tickets: BOOT_TICKETS.slice(0, 2) },
			{ config: PULLS_CONFIG, tickets: [BOOT_TICKETS[2]] },
		],
		agentHostEnv: fields.agentHostEnv,
	});
}

function paintedOrder(setup: AppSetup): string[] {
	const frame = setup.captureCharFrame();
	const titles = [...TITLES.values()];
	return rowsOf(frame)
		.map((row) => listHalfOf(row).replace(/[│┌┐└┘─]/g, " "))
		.filter((text) => titles.some((title) => text.includes(title)))
		.map((text) => titles.find((title) => text.includes(title)) ?? "");
}

function listMoves(setup: AppSetup) {
	const orders: string[][] = [];
	const record = () => {
		const order = paintedOrder(setup);
		if (order.length === 0) return;
		const last = orders.at(-1);
		if (last === undefined || last.join("|") !== order.join("|")) orders.push(order);
	};
	return { orders, record };
}

const POLL_MS = 5000;

/**
 * The two-stage settle both list-move tests stand on: the sources' boot
 * reads in flight, the issues source's answer while the load still stands,
 * and the pulls source's answer that settles it. The paint at each step
 * stands beside the move recorder, so a move at a step that must stand
 * still shows up as an extra order.
 */
async function settleInTwoStages(setup: AppSetup) {
	const [issues, pulls] = setup.plane.sources as readonly FakeSource[];
	const { orders, record } = listMoves(setup);
	await callsReached(issues, 1);
	await callsReached(pulls, 1);
	record();
	const standing = paintedOrder(setup);
	issues.settle(ISSUES_SETTLED);
	await sleep(50);
	record();
	const afterFirst = paintedOrder(setup);
	pulls.settle(PULLS_SETTLED);
	await settle(setup);
	record();
	const settled = paintedOrder(setup);
	return { orders, standing, afterFirst, settled };
}

describe("the plane holds its first list move until the initial load settles (issue #431, ADR 0154)", () => {
	test("the ticket list stands on the boot read and moves exactly once, on the settled load", async () => {
		const planeRecord = await settledPlane();
		await withApp(
			async (setup) => {
				const moves = await settleInTwoStages(setup);
				// The load stood on the in-flight boot reads: the list stood
				// on the state the plane booted on, and the issues source's
				// settlement while the load stood moved nothing.
				expect(moves.standing).toEqual(BOOT_ORDER);
				expect(moves.afterFirst).toEqual(BOOT_ORDER);
				// The last source's answer settles the load: the list moves
				// once, from the state that stands on the settled sources
				// joined with the state it held.
				expect(moves.settled).toEqual(SETTLED_ORDER);
				expect(moves.orders).toEqual([BOOT_ORDER, SETTLED_ORDER]);
			},
			{
				width: 120,
				height: 30,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: POLL_MS },
			},
		);
	});

	test("the first herdr probe lands on the settle, after the sources' boot reads", async () => {
		// The herdr host: the plane's probe is the herdr roster read, the
		// command the fake runner lists.
		const planeRecord = await settledPlane({ agentHostEnv: { herdrEnv: "1" } });
		await withApp(
			async (setup) => {
				const [issues, pulls] = setup.plane.sources as readonly FakeSource[];
				await callsReached(issues, 1);
				await callsReached(pulls, 1);
				const probes = () =>
					setup.plane.fakeRunner.commands().filter((command) => command === "herdr agent list");
				// While the load stands the plane runs no Observation cycle,
				// so no herdr probe has run on the empty roster.
				expect(probes()).toHaveLength(0);

				issues.settle(ISSUES_SETTLED);
				// One source's settlement settles nothing on its own.
				expect(probes()).toHaveLength(0);

				pulls.settle(PULLS_SETTLED);
				// The settle resolves the load: the first probe runs on it.
				await frameUntil(setup, "the first herdr probe", () => probes().length === 1);
				expect(probes()).toHaveLength(1);
			},
			{
				width: 120,
				height: 30,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: POLL_MS },
			},
		);
	});

	test("an in-flight ticket wears its state face, and the marker stands on the probe after the settle", async () => {
		// Pinned past the startup grace: the recorded start is a dead Agent,
		// not a booting one, so the first probe reads it missing.
		const dir = mkdtempSync(join(tmpdir(), "factory-settle-face-"));
		paths.push(dir);
		const state = reopenState(join(dir, "state.sqlite"), () => Date.now() - 60_000);
		const inFlightIdentity = "github:github.com:I_5";
		const openIdentity = "github:github.com:I_6";
		const fetched = [
			issueTicket(inFlightIdentity),
			issueTicket(openIdentity, { title: "Delta task", externalKey: "#6" }),
		];
		const outcome = fetchSuccess(fetched);
		seedInFlightTurn(state, outcome, inFlightIdentity);
		const runner = emptyAgentRunner();
		const planeRecord = await plane({
			agentHostEnv: { herdrEnv: "1" },
			existing: state,
			groupingAxis: "none",
			runner: () => runner,
			sources: [{ config: issuesSourceConfig, tickets: fetched.map((ticket) => ticketOf(ticket)) }],
			repos: { "github.com/acme/factory": "src/factory" },
		});
		await withApp(
			async (setup) => {
				const [source] = setup.plane.sources as readonly FakeSource[];
				await callsReached(source, 1);
				const frame = setup.captureCharFrame();
				// The load stands: no herdr probe has run and no agent report
				// stands, so no row wears the Missing marker.
				expect(frame).not.toContain("missing");
				// The in-flight ticket is the selected row: the Starting window
				// holds it, and it wears the spinner face in place of its badge.
				const row = listHalfOf(rowsOf(frame)[markerRowOf(frame)]);
				expect(startingFaceOf(row)).not.toBeNull();
				// The open ticket beside it wears its state badge.
				expect(frame).toContain("[open]");

				// The settle resolves the load and runs the first probe: the
				// start stands old past its grace on the empty roster, so the
				// marker appears on that probe, not before it.
				planeRecord.settleFirstFetch();
				await frameUntil(setup, "the missing badge", (f) =>
					rowsOf(f).some((r) => r.startsWith("│") && r.includes("missing")),
				);
			},
			{
				width: 120,
				height: 30,
				plane: planeRecord,
				loopPolicy: { kind: "polled", intervalMs: 60_000 },
			},
		);
	});

	test("the seeded plane on the held loop policy settles the load on the one-shot boot read, and its list moves once", async () => {
		const planeRecord = await settledPlane();
		await withApp(
			async (setup) => {
				const moves = await settleInTwoStages(setup);
				expect(moves.standing).toEqual(BOOT_ORDER);
				expect(moves.afterFirst).toEqual(BOOT_ORDER);
				expect(moves.settled).toEqual(SETTLED_ORDER);
				expect(moves.orders).toEqual([BOOT_ORDER, SETTLED_ORDER]);
				// The held plane runs no Observation loop at all (ADR 0129):
				// the settle moment is pinned by the list's one move on the
				// one-shot boot read, the settle path the live plane runs.
				expect(
					setup.plane.fakeRunner.commands().filter((command) => command === "herdr agent list"),
				).toHaveLength(0);
			},
			{ width: 120, height: 30, plane: planeRecord },
		);
	});
});
