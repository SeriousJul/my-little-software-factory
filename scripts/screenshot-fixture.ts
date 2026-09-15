/**
 * The screenshot fixture: one factory world, arranged for the screens the
 * guides show.
 *
 * The world is a temporary directory holding a config, a seeded state file,
 * and three stub executables the production binary resolves through PATH:
 * `gh` answers the ticket source's search query with a fixed page, `pi`
 * reports a fixed model list, and `herdr` reports two live agent panes -
 * one working on the in-flight ticket, one holding a Consultation. The
 * screenshots are the production renderer's bytes over this world: real
 * frames, canned facts.
 *
 * The screens one session walks:
 *
 * 1. `main-view` - the Main view: both sections open, one ticket in each
 *    state, the detail pane on the open ticket.
 * 2. `override-panel` - the Override panel on the open ticket.
 * 3. `decision-modal` - the decision modal on the ticket awaiting a
 *    decision, its turn log below the decision.
 * 4. `consultation` - a working Consultation in the detail pane.
 * 5. `live-view` - the Live view streaming the in-flight agent's terminal.
 * 6. `turn-log` - the same Live view after the agent settles its turn:
 *    the box switches to the decision.
 *
 * Screen 6 is the only time-dependent one: the `herdr` stub reports the
 * in-flight agent as working until the capture touches `done.flag`, and the
 * observation poll (one second) settles the turn from that point on.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import type { SourceDefinition } from "../src/state.ts";
import { openFactoryState } from "../src/state.ts";
import { openControlPlanePty } from "../test/executable-pty.ts";
import { parseScreen, renderPng } from "./ansi-render.ts";

/** The screen the screenshots show: the size the PTY opens with. */
export const SCREEN = { cols: 180, rows: 40 } as const;

/** The six screens, in capture order, with the doc page each belongs to. */
export interface ScreenshotTarget {
	name: string;
	/** The output file name, a png next to the doc that shows it. */
	file: string;
	/** The docs folder the png is committed to. */
	docDir: string;
}
export const SCREENSHOTS: readonly ScreenshotTarget[] = [
	{ name: "main-view", file: "main-view.png", docDir: "operation/images" },
	{ name: "override-panel", file: "override-panel.png", docDir: "operation/images" },
	{ name: "decision-modal", file: "decision-modal.png", docDir: "operation/images" },
	{ name: "consultation", file: "consultation.png", docDir: "operation/images" },
	{ name: "live-view", file: "live-view.png", docDir: "operation/images" },
	{ name: "turn-log", file: "turn-log.png", docDir: "operation/images" },
];

const REPO = "SeriousJul/my-little-software-factory";
const REPO_URL = `https://github.com/${REPO}`;
const NOW = "2026-07-07T09:00:00.000Z";

const issue = (
	number: number,
	title: string,
	body: string,
	labels: string[],
	updatedAt: string,
): FetchedTicket => ({
	identity: `github:github.com:I_fixture${number}`,
	sourceKind: "github-issue",
	externalKey: `#${number}`,
	sourceState: "open",
	url: `${REPO_URL}/issues/${number}`,
	title,
	description: body,
	labels,
	externalUpdatedAt: updatedAt,
	repository: {
		identity: `github.com/${REPO.toLowerCase()}`,
		displayName: REPO,
		cloneUrl: `${REPO_URL}.git`,
	},
	attributes: {},
});

/** The three tickets, one per ticket state the Main view shows. */
const TICKETS: readonly FetchedTicket[] = [
	issue(
		53,
		"Split the README into published guides",
		"Move the long README sections into the documentation site and keep the\nREADME a short landing page.",
		["ready-for-agent"],
		"2026-07-07T08:41:00Z",
	),
	issue(
		52,
		"Retry failed webhook deliveries with a bounded backoff",
		"Deliveries that fail with a 5xx are dropped. Retry them with a bounded\nexponential backoff and give up after the third attempt.",
		["ready-for-agent", "needs-work"],
		"2026-07-07T07:58:00Z",
	),
	issue(
		51,
		"Rank tickets by priority label",
		"Ranked tickets stay ahead of unranked ones. The operator bumps a\npriority with =, +, and -.",
		["ready-for-agent"],
		"2026-07-07T06:12:00Z",
	),
];
const RUNNING_TICKET = TICKETS[1].identity;
const AWAITING_TICKET = TICKETS[2].identity;

/** The turn log the settled turn of the awaiting ticket carries. */
// The awaiting ticket's completed turn: a review of its ranking change, so
// its decision offers the review's outgoing edges (merge, rework) and the
// in-flight implement ticket's decision (Handoff: review) stays the only
// place that string appears while the capture runs.
const TURN_LOG = [
	{ kind: "text" as const, text: "Reviewing the ranking change in src/state.ts." },
	{ kind: "tool" as const, name: "read_file", target: "src/state.ts", failed: false },
	{
		kind: "text" as const,
		text: "Ranked tickets sort ahead of unranked ones inside their\nattention group; the unranked order stays untouched.",
	},
	{ kind: "tool" as const, name: "run_command", target: "npm test", failed: false },
	{ kind: "text" as const, text: "214 tests pass. The change is ready to merge." },
];

/** The in-flight agent's terminal, as `herdr agent read` reports it. */
const RUNNING_PANE_TEXT = [
	"pi  anthropic/claude-sonnet-4-5",
	"",
	"Reading the webhook handler to find the delivery path.",
	"  read_file src/webhooks/handler.ts",
	"  read_file src/webhooks/queue.ts",
	"Adding a retry queue with a bounded backoff:",
	"  edit_file src/webhooks/queue.ts",
	"  edit_file src/webhooks/handler.ts",
	"Writing the delivery tests.",
	"  write_file src/webhooks/queue.test.ts",
].join("\n");

/** The Consultation's terminal, as `herdr agent read` reports it. */
const CONSULTATION_PANE_TEXT = [
	"codex  gpt-5.6-codex",
	"",
	"Reading the retry budget ADR before I ask anything.",
	"  read docs/adr/0009-handoff-settings-follow-their-agent.md",
	"Three questions before this holds:",
	"1. Who owns the retry budget across an agent restart?",
	"2. Is the backoff base a config value or a constant?",
	"3. What does the ticket carry when retries exhaust?",
].join("\n");

/** The config the fixture world runs on. */
function configToml(dir: string): string {
	return `
default-agent = "pi"
default-environment = "live-worktree"
default-task-type = "implement"
state-file = "${join(dir, "state.sqlite")}"
agent-poll-interval-seconds = 1

[agents.pi]
kind = "pi"
model = "--model {value}"
thinking = "--thinking {value}"
thinking-values = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

[agents.codex]
kind = "codex"
model = "--model {value}"
thinking = "-c model_reasoning_effort={value}"
thinking-values = ["minimal", "low", "medium", "high"]
context-window = "-c model_context_window={value}"

[task-types.implement]
agent = "pi"
model = "anthropic/claude-sonnet-4-5"
template = '''Implement the following {source-kind}.

Repository: {repository}

{external-key}: {title}

URL: {source-url}

Labels: {labels}

Description:
{description}'''
thinking = "medium"
auto-close = false

[task-types.review]
agent = "codex"
template = '''Review pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}'''
auto-close = false

[task-types.rework]
template = '''Rework pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}'''
auto-close = false

[task-types.merge]
template = '''Merge pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}'''
thinking = "low"
auto-close = true

[consultation-types.grill-with-docs]
agent = "codex"
environment = "live-worktree"
template = "/skill:grill-with-docs {input}"

[[workflows]]
from = "implement"
to = ["review"]
agent = "pi"
environment = "worktree"

[[workflows]]
from = "review"
to = ["merge", "rework"]

[[workflows]]
from = "rework"
to = ["review"]

[[sources]]
name = "issues"
kind = "github-issues"
refresh-interval-seconds = 30
repositories = ["${REPO}"]
`;
}

/** The `gh` stub: the ticket source's search query, answered with a fixed page. */
const ghNode = (
	number: number,
	title: string,
	body: string,
	labels: string[],
	updatedAt: string,
): Record<string, unknown> => ({
	__typename: "Issue",
	id: `I_fixture${number}`,
	number,
	title,
	body,
	url: `${REPO_URL}/issues/${number}`,
	state: "OPEN",
	updatedAt,
	labels: { nodes: labels.map((name) => ({ name })) },
	repository: {
		name: "my-little-software-factory",
		nameWithOwner: REPO,
		url: REPO_URL,
	},
});

/**
 * The `gh` stub: the ticket source's search query, answered with a fixed
 * page. The page is one single-quoted shell string, so the stub itself holds
 * no quotes of its own.
 */
const GH_STUB = [
	"#!/bin/sh",
	"# Screenshot stub for gh: one fixed search page for the fixture repository.",
	"# Shell builtins only: the fixture PATH holds this bin dir and nothing else.",
	'[ "$1" = "api" ] || exit 1',
	`printf '%s' '${JSON.stringify({
		data: {
			search: {
				issueCount: 3,
				pageInfo: { hasNextPage: false, endCursor: null },
				nodes: [
					ghNode(
						53,
						"Split the README into published guides",
						"Move the long README sections into the documentation site and keep the README a short landing page.",
						["ready-for-agent"],
						"2026-07-07T08:41:00Z",
					),
					ghNode(
						52,
						"Retry failed webhook deliveries with a bounded backoff",
						"Deliveries that fail with a 5xx are dropped. Retry them with a bounded exponential backoff and give up after the third attempt.",
						["ready-for-agent", "needs-work"],
						"2026-07-07T07:58:00Z",
					),
					ghNode(
						51,
						"Rank tickets by priority label",
						"Ranked tickets stay ahead of unranked ones. The operator bumps a priority with =, +, and -.",
						["ready-for-agent"],
						"2026-07-07T06:12:00Z",
					),
				],
			},
		},
	})}'`,
	"exit 0",
	"",
].join("\n");

/** The `pi` stub: the model list the override panel offers. */
const PI_STUB = `#!/bin/sh
# Screenshot stub for pi: one fixed model list. Builtins only: the fixture
# PATH holds this bin dir and nothing else.
[ "$1" = "--list-models" ] || exit 1
printf '%s\\n' 'provider  model  context  max-out  thinking  images'
printf '%s\\n' 'anthropic  claude-opus-4-6  200000  32768  true  true'
printf '%s\\n' 'anthropic  claude-sonnet-4-5  200000  32768  true  true'
printf '%s\\n' 'anthropic  claude-haiku-4-5  200000  32768  true  true'
exit 0
`;

/**
 * The `herdr` stub: two live panes. `pane-2` works the in-flight ticket and
 * reports working until the capture touches `done.flag`; `pane-3` holds the
 * Consultation. No agent reports a session, so the settled turn's log is its
 * terminal capture, the fallback the reader is built for.
 */
const HERDR_STUB = `#!/bin/sh
# Screenshot stub for herdr: the fixture's two live agent panes.
# Shell builtins only: the fixture PATH holds this bin dir and nothing else.
dir="\${0%/*}/.."
[ "$1" = "agent" ] || exit 1
case "$2" in
list)
  status="working"
  [ -f "$dir/done.flag" ] && status="done"
  printf '%s' '{"result":{"agents":[{"pane_id":"pane-2","tab_id":"tab-2","workspace_id":"ws-2","agent":"pi","checkout_path":"/home/seriousjul/src/my-little-software-factory","agent_status":"'
  printf '%s' "$status"
  printf '%s' '"},{"pane_id":"pane-3","tab_id":"tab-3","workspace_id":"ws-3","agent":"codex","checkout_path":"/home/seriousjul/src/my-little-software-factory","agent_status":"working"}]}}'
  ;;
read)
  case "$3" in
  pane-2)
    printf '%s' '{"result":{"output":"${RUNNING_PANE_TEXT.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"}}'
    ;;
  pane-3)
    printf '%s' '{"result":{"output":"${CONSULTATION_PANE_TEXT.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"}}'
    ;;
  *)
    exit 1
    ;;
  esac
  ;;
*)
  exit 1
  ;;
esac
`;

/** Seed the state file: three tickets in three states, one Consultation. */
function seedState(path: string): void {
	const state = openFactoryState(path, () => Date.parse(NOW));
	const source: SourceDefinition = { name: "issues", kind: "github-issues" };
	state.initializeSources([source]);
	state.applyFetch(source, { status: "success", fetchedAt: NOW, tickets: [...TICKETS] });

	// The in-flight ticket: claimed and started, its agent working in pane-2.
	const runningClaim = state.claimHandoff(
		RUNNING_TICKET,
		{
			agentType: "pi",
			environment: "live-worktree",
			taskType: "implement",
			model: "anthropic/claude-sonnet-4-5",
			thinking: "medium",
			contextWindow: "",
		},
		"open",
	);
	if (!runningClaim.ok) throw new Error(`fixture: running claim: ${runningClaim.reason}`);
	state.settleHandoff(runningClaim.claim.attemptId, true, undefined, {
		paneId: "pane-2",
		tabId: "tab-2",
		workspaceId: "ws-2",
	});

	// The awaiting ticket: claimed, started, and its turn settled.
	const awaitingClaim = state.claimHandoff(
		AWAITING_TICKET,
		{
			agentType: "pi",
			environment: "live-worktree",
			taskType: "implement",
			model: "anthropic/claude-sonnet-4-5",
			thinking: "medium",
			contextWindow: "",
		},
		"open",
	);
	if (!awaitingClaim.ok) throw new Error(`fixture: awaiting claim: ${awaitingClaim.reason}`);
	state.settleHandoff(awaitingClaim.claim.attemptId, true, undefined, {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
	state.settleTurn({
		ticketIdentity: AWAITING_TICKET,
		handoffId: awaitingClaim.claim.attemptId,
		taskType: "review",
		agentType: "pi",
		message: "The ranking change is reviewed: ranked tickets stay ahead of unranked ones.",
		turnLog: [...TURN_LOG],
		cause: "completed",
		completedAt: NOW,
	});

	// The Consultation: launched and working in pane-3.
	const consultation = state.createConsultation({
		typeName: "grill-with-docs",
		agentType: "codex",
		environment: "live-worktree",
		template: "/skill:grill-with-docs {input}",
		initialInput: "The webhook retry policy: who owns the retry budget across an agent restart?",
		renderedOpeningPrompt:
			"/skill:grill-with-docs The webhook retry policy: who owns the retry budget across an agent restart?",
		repository: {
			identity: `github.com/${REPO.toLowerCase()}`,
			displayName: REPO,
			cloneUrl: `${REPO_URL}.git`,
			path: "/home/seriousjul/src/my-little-software-factory",
		},
		agentName: "consult-retry-budget",
		createdAt: NOW,
	});
	state.setConsultationAgent(consultation.id, {
		paneId: "pane-3",
		tabId: "tab-3",
		workspaceId: "ws-3",
	});
	state.close();
}

/** Write the fixture world into a fresh directory and return its path. */
export function buildFixture(root: string): string {
	const dir = mkdtempSync(join(root, "factory-screenshots-"));
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFileSync(join(dir, "config.toml"), configToml(dir));
	writeFileSync(join(dir, "bin", "gh"), GH_STUB);
	writeFileSync(join(dir, "bin", "pi"), PI_STUB);
	writeFileSync(join(dir, "bin", "herdr"), HERDR_STUB);
	for (const name of ["gh", "pi", "herdr"]) chmodSync(join(dir, "bin", name), 0o755);
	seedState(join(dir, "state.sqlite"));
	return dir;
}

/**
 * Walk one PTY session through the six screens and return each as a PNG.
 *
 * The session accumulates bytes; each capture renders the stream so far into
 * the grid the PTY holds, so a capture is the screen as it stands then.
 */
export async function captureScreens(fixtureDir: string): Promise<Map<string, Buffer>> {
	const out = new Map<string, Buffer>();
	const session = await openControlPlanePty(
		["--config", join(fixtureDir, "config.toml")],
		{
			HOME: fixtureDir,
			XDG_CONFIG_HOME: join(fixtureDir, ".config"),
			XDG_STATE_HOME: join(fixtureDir, ".state"),
			XDG_DATA_HOME: join(fixtureDir, ".data"),
			XDG_CACHE_HOME: join(fixtureDir, ".cache"),
			PATH: join(fixtureDir, "bin"),
		},
		{ size: { cols: SCREEN.cols, rows: SCREEN.rows } },
	);
	if (session === null) throw new Error("screenshots: this platform cannot open a PTY");

	const log = (what: string) => console.error(`screenshots: ${what}`);
	const capture = async (name: string) => {
		log(`capturing ${name}`);
		await session.waitForStable(300, 15000);
		const grid = parseScreen(session.output(), SCREEN.cols, SCREEN.rows);
		out.set(name, renderPng(grid));
	};
	const key = (bytes: string) => {
		session.write(bytes);
	};

	try {
		// 1. The Main view, once the fetch lands its tickets and the observation
		// marks the in-flight one running. The cursor rests on the first row,
		// the ticket awaiting a decision.
		await session.waitFor(
			(data) => data.includes("open: 1  running: 1  awaiting: 1"),
			"the full ticket list",
			30000,
		);
		log("main view ready");
		await capture("main-view");

		// 2. The Override panel on the open ticket (third row).
		key("j");
		await sleep(120);
		key("j");
		await sleep(120);
		key("e");
		log("pressed e for the override panel");
		await session.waitFor((data) => data.includes("Task type"), "the override panel", 15000);
		// Let the model list query settle so the Model row shows its value.
		await sleep(800);
		await session.waitForStable(400, 15000);
		await capture("override-panel");
		log("override panel captured");
		key("\x1b");
		await sleep(250);

		// 3. The decision modal on the awaiting ticket (first row): Enter on it
		// is Decide, and the modal opens with the turn log as its body.
		key("k");
		await sleep(120);
		key("k");
		await sleep(120);
		key("\r");
		log("pressed Enter for the decision modal");
		await session.waitFor((data) => data.includes("Decision: "), "the decision modal", 15000);
		await capture("decision-modal");
		key("\x1b");
		await sleep(250);

		// 4. The Consultation: three rows down, past the ticket section, into
		// the Consultations section. The detail pane shows its input.
		key("j");
		await sleep(120);
		key("j");
		await sleep(120);
		key("j");
		log("moving into the consultations section");
		await session.waitFor(
			(data) => data.includes("retry budget"),
			"the consultation detail",
			15000,
		);
		await sleep(1200);
		await capture("consultation");

		// 5. The Live view on the in-flight ticket (second row): two rows up,
		// Enter opens the agent's stream in the left box.
		key("k");
		await sleep(120);
		key("k");
		await sleep(120);
		key("\r");
		log("opened the live view");
		await session.waitFor((data) => data.includes("bounded backoff"), "the live stream", 20000);
		await capture("live-view");

		// 6. The same box after the turn settles: touch the flag, wait for the
		// observation poll to settle the turn (the awaiting count moves), and
		// the Live view switches to the decision.
		log("live view captured; flagging the turn settled");
		writeFileSync(join(fixtureDir, "done.flag"), "");
		// The live decision's implement-to-review row is the first place that
		// label appears: the awaiting ticket's modal offered merge and rework.
		await session.waitFor((data) => data.includes("Handoff: review"), "the settled turn", 30000);
		await sleep(400);
		await session.waitForStable(400, 15000);
		await capture("turn-log");
	} finally {
		// Kill rather than wait: the app has no exit key the capture sends.
		session.dispose();
	}
	return out;
}

/** Run the capture end to end: build the world, capture, clean up. */
export async function generateScreenshots(): Promise<Map<string, Buffer>> {
	const root = tmpdir();
	const fixtureDir = buildFixture(root);
	try {
		return await captureScreens(fixtureDir);
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
}
