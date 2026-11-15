/**
 * The in-flight ticket world the Live view and the screen stack suites stand
 * on: the ticket claimed and settled to the stored herdr handles, the pane
 * reads its stream runs, and the route standing the machine builds when the
 * turn settles. Each suite keeps its own frames, its own walks, and its own
 * assertions; the world they boot into stands here.
 */
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactoryConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { BASE_CONFIG } from "./base-config.ts";
import { DEFAULT_TICKET_TITLE, fetchedTicket, ticketOf } from "./fact-fixtures.ts";
import { agentListJson, type FakeRunner, tabCreateJson, workspaceListJson } from "./fake-runner.ts";
import { type Plane, plane } from "./plane.ts";

/** The pane read the Live view's stream runs, for a pane and its tail. */
export const READ = (pane: string) =>
	["agent", "read", pane, "--lines", "200", "--source", "visible", "--format", "text"] as const;

/** The exact command string a pane read records in the runner. */
export const READ_COMMAND = (pane: string) =>
	`herdr agent read ${pane} --lines 200 --source visible --format text`;

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * The path of a pi session record of one completed turn, the way herdr
 * reports it. The turn's end is in the record, so the settle is immediate,
 * without the startup grace (ADR 0017).
 */
export function settledSession(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "factory-live-world-"));
	paths.push(dir);
	const file = join(dir, "session.jsonl");
	writeFileSync(
		file,
		`${JSON.stringify({
			type: "message",
			timestamp: "2026-08-31T11:00:00Z",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text }],
			},
		})}\n`,
		"utf8",
	);
	return file;
}

/** The implementer's pane alone, live in herdr. */
export function onePaneAgentList(status: string): string {
	return agentListJson([
		{
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			agent: "persist-source-facts",
			status,
			sessionId: settledSession("the implementer is finishing"),
		},
	]);
}

/**
 * The settled implementer's pane and the new agent's pane, both live, so a
 * stream can move to the new pane the moment its handoff settles.
 */
export function twoPaneAgentList(status1: string, status9: string): string {
	return agentListJson([
		{
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			agent: "persist-source-facts",
			status: status1,
			sessionId: settledSession("the implementer is finishing"),
		},
		{
			paneId: "pane-9",
			tabId: "tab-9",
			workspaceId: "ws-1",
			agent: "persist-source-facts",
			status: status9,
		},
	]);
}

/** The route standing: the stored workspace, the new tab, and both panes' first reads. */
export function stubRouteStanding(fake: FakeRunner, checkoutPath: string): void {
	fake.set("herdr", ["workspace", "list"], {
		stdout: workspaceListJson([{ id: "ws-1", checkoutPath }]),
	});
	fake.set("herdr", ["tab", "create", "--workspace", "ws-1", "--no-focus"], {
		stdout: tabCreateJson("pane-9", "tab-9"),
	});
	fake.set("herdr", [...READ("pane-1")], { stdout: "the implementer is finishing\n" });
	fake.set("herdr", [...READ("pane-9")], { stdout: "the reviewer is on it\n" });
}

/** The tick lines a pane read stands. */
export function tickLines(count: number): string {
	return Array.from({ length: count }, (_, i) => `tick ${String(i + 1).padStart(2, "0")}`).join(
		"\n",
	);
}

export const identity = "github:github.com:I_5";
export const repoIdentity = "github.com/acme/factory";

export function fetched(index = 5, title = DEFAULT_TICKET_TITLE): FetchedTicket {
	return fetchedTicket({ identity: `github:github.com:I_${index}`, title });
}

/** Stub the git answers for the checkout the plane's config maps to. */
export function stubCheckoutInto(fake: FakeRunner, home: string): void {
	const path = join(home, "src", "factory");
	fake.set("git", ["-C", path, "rev-parse", "--git-dir"], { stdout: ".git\n" });
	fake.set("git", ["-C", path, "remote", "get-url", "origin"], {
		stdout: `https://${repoIdentity}.git\n`,
	});
}

/** The source config the standing lists its ticket on. */
export const sourceConfig = {
	name: "issues",
	kind: "github-issues" as const,
	refreshIntervalSeconds: 60,
	repositories: [repoIdentity],
	host: "github.com",
};

/**
 * The plane the factory-level tests stand on: the ticket in flight -
 * claimed, settled to the stored herdr handles, and resting in handed-off -
 * on the flat Grouping axis, under the config the case names over the base,
 * on the pinned clock the fixture day writes from. The handoff starts inside
 * the fixture day, so a session record stamped on it is this run's, not the
 * run before: the staleness guard keeps the settle's `completed` cause.
 */
export async function seededPlane(extra: Partial<FactoryConfig> = {}): Promise<Plane> {
	const ticket = ticketOf(fetched(), {
		state: "handed-off",
		workCycle: 2,
		handoff: {
			agentType: "pi",
			environment: "live-worktree",
			taskType: "implement",
			host: "herdr" as const,
			model: "",
			thinking: "",
			contextWindow: "",
			attemptId: "attempt-implement",
			paneId: "pane-1",
			tabId: "tab-1",
			workspaceId: "ws-1",
			herdrName: "persist-source-facts",
			startedAt: "2026-01-01T00:00:00Z",
		},
	});
	return await plane({
		groupingAxis: "none",
		now: () => Date.parse("2026-08-31T10:30:00Z"),
		sources: [{ config: sourceConfig, tickets: [ticket] }],
		repos: { [repoIdentity]: "src/factory" },
		config: {
			// The issue-side machine these tests fire: the implement transition
			// writes the review fact, and the state it lands on offers the review.
			workflowStates: [
				{
					name: "ready-for-review",
					taskType: "review",
					match: { labelsAny: ["ready-for-review"] },
				},
			],
			taskTypes: {
				...BASE_CONFIG.taskTypes,
				implement: {
					...BASE_CONFIG.taskTypes.implement,
					transition: { ticketFacts: ["ready-for-review"], pullRequestFacts: [] },
				},
			},
			...extra,
		},
		agentHostEnv: { herdrEnv: "1" },
	});
}
