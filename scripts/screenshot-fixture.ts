/**
 * The screenshot fixture: one factory world, arranged for the screens the
 * guides show.
 *
 * The world is a temporary directory holding a config, a seeded state file,
 * and three stub executables the production binary resolves through PATH:
 * `gh` answers the ticket source's search query with one fixed page per
 * fixture repository, `pi` reports a fixed model list, and `herdr` reports
 * three live agent panes - one working on the in-flight ticket, one holding
 * the working Consultation, one idle beside the Consultation that awaits its
 * answer. The screenshots are the production renderer's bytes over this
 * world: real frames, canned facts.
 *
 * The world holds two repositories, the way the operator's real one does:
 * the factory itself, with a ticket in each state the Main view shows, and
 * `SeriousJul/pi-extensions`, with two open issues, one of which waits in
 * the Work queue. The ticket list stands grouped by repository (the axis the
 * operator chose, ADR 0058), so the two repositories read as two Groups.
 *
 * The screens one session walks:
 *
 * 1. `main-view` - the Main view: the ticket list grouped by repository,
 *    the queue holding one start, the detail pane on the awaiting ticket.
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
import { parse } from "smol-toml";
import { validateConfig } from "../src/config.ts";
import type { FetchedTicket } from "../src/domain/ticket.ts";
import { repositoryInitSettingsHash } from "../src/repo-init.ts";
import type { SourceDefinition } from "../src/state/source-fact.ts";
import { openFactoryState } from "../src/state.ts";
import { openControlPlanePty } from "../test/executable-pty.ts";
import { parseScreen, renderPng, type TerminalColors } from "./ansi-render.ts";

/** The screen the screenshots show: the size the PTY opens with. */
export const SCREEN = { cols: 180, rows: 40 } as const;

/** The screen the hero shot shows: the plane full width, plus herdr's sidebar. */
export const HERO_SCREEN = { cols: 256, rows: 56 } as const;

/**
 * The herdr theme the screenshots render with: the theme the operator's
 * herdr stands on, pinned so the committed images are byte-stable on every
 * machine (the drift test regenerates them outside the operator's herdr).
 * The fixture world stands inside a herdr pane, so the plane resolves the
 * theme through the same herdr-config path a live run takes (ADR 0024).
 * Update it when the operator's herdr changes theme, and re-run
 * `npm run screenshots` and `npm run hero`.
 */
export const HERDR_THEME_NAME = "one-dark";

/**
 * The terminal colors the screenshots paint with, pinned beside the theme
 * (ADR 0123): the terminal background, the terminal foreground, and the
 * sixteen basic colors, copied from the theme the operator's desktop stands
 * on, which is tokyo-night today. A capture reads nothing from the machine
 * it runs on, so the committed bytes stay the same on every machine. The
 * block moves by hand when the desktop theme moves, and
 * `npm run screenshots` and `npm run hero` re-run after it.
 */
export const TERMINAL_COLORS: TerminalColors = {
	background: [26, 27, 38], // #1a1b26
	foreground: [169, 177, 214], // #a9b1d6
	basic: [
		[26, 27, 38], // #1a1b26
		[247, 118, 142], // #f7768e
		[158, 206, 106], // #9ece6a
		[224, 175, 104], // #e0af68
		[122, 162, 247], // #7aa2f7
		[173, 142, 230], // #ad8ee6
		[68, 157, 171], // #449dab
		[169, 177, 214], // #a9b1d6
		[65, 72, 104], // #414868
		[255, 122, 147], // #ff7a93
		[185, 242, 124], // #b9f27c
		[255, 158, 100], // #ff9e64
		[125, 166, 255], // #7da6ff
		[187, 154, 247], // #bb9af7
		[13, 185, 215], // #0db9d7
		[192, 202, 245], // #c0caf5
	],
};

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

const REPO_A = "SeriousJul/my-little-software-factory";
const REPO_A_URL = `https://github.com/${REPO_A}`;
const REPO_B = "SeriousJul/pi-extensions";
const REPO_B_URL = `https://github.com/${REPO_B}`;
const NOW = "2026-07-07T09:00:00.000Z";

const issue = (
	number: number,
	title: string,
	body: string,
	labels: string[],
	updatedAt: string,
	repository: string,
	repositoryUrl: string,
): FetchedTicket => ({
	identity: `github:github.com:I_fixture${number}`,
	sourceKind: "github-issue",
	externalKey: `#${number}`,
	sourceState: "open",
	url: `${repositoryUrl}/issues/${number}`,
	title,
	description: body,
	labels,
	externalUpdatedAt: updatedAt,
	repository: {
		identity: `github.com/${repository.toLowerCase()}`,
		displayName: repository,
		cloneUrl: `${repositoryUrl}.git`,
	},
	attributes: {},
});

/** The tickets: three in the factory repository, two in pi-extensions. */
const OPEN_TICKET = issue(
	53,
	"Split the README into published guides",
	"Move the long README sections into the documentation site and keep the\nREADME a short landing page.",
	["ready-for-agent"],
	"2026-07-07T08:41:00Z",
	REPO_A,
	REPO_A_URL,
);
const RUNNING_TICKET = issue(
	52,
	"Retry failed webhook deliveries with a bounded backoff",
	"Deliveries that fail with a 5xx are dropped. Retry them with a bounded\nexponential backoff and give up after the third attempt.",
	["ready-for-agent", "needs-work"],
	"2026-07-07T07:58:00Z",
	REPO_A,
	REPO_A_URL,
);
// The source's own truth after the review's write: the ticket wears the ship
// fact the machine landed on it, the way GitHub does once the write lands.
const AWAITING_TICKET = issue(
	51,
	"Rank tickets by priority label",
	"Ranked tickets stay ahead of unranked ones. The operator bumps a\npriority with =, +, and -.",
	["ready-to-ship"],
	"2026-07-07T06:12:00Z",
	REPO_A,
	REPO_A_URL,
);
const SKILL_REPORT_TICKET = issue(
	87,
	"Give the code review skill a shared report format",
	"The code review skill prints its findings in its own shape. Give it one\nshared report format the operator can file.",
	["ready-for-agent"],
	"2026-07-07T08:55:00Z",
	REPO_B,
	REPO_B_URL,
);
const SKILL_INDEX_TICKET = issue(
	88,
	"Let find-skills index the local skill directories",
	"The find-skills search covers installed skills only. Let it index the\nlocal skill directories too.",
	[],
	"2026-07-07T08:20:00Z",
	REPO_B,
	REPO_B_URL,
);
const TICKETS: readonly FetchedTicket[] = [
	OPEN_TICKET,
	RUNNING_TICKET,
	AWAITING_TICKET,
	SKILL_REPORT_TICKET,
	SKILL_INDEX_TICKET,
];
/** The turn log the settled turn of the awaiting ticket carries. */
// The awaiting ticket's completed turn: a review of its ranking change. The
// seed stores the review transition's outcome on it, so its decision offers
// the merge position the written ready-to-ship fact derives, and the
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

/** The working Consultation's terminal, as `herdr agent read` reports it. */
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

/** The idle Consultation's terminal, as `herdr agent read` reports it. */
const IDLE_PANE_TEXT = [
	"codex  gpt-5.6-codex",
	"",
	"Reading the find-skills index before I answer.",
	"  read skills/local/find-skills/SKILL.md",
	"Paths or copies: one question before this holds.",
	"1. Should the index store paths to local skills, or copies of them?",
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
[task-types.implement.transition]
ticket-facts = ["ready-for-review"]
pull-request-facts = []

[task-types.review]
agent = "codex"
template = '''Review pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}'''
[task-types.review.transition]
ticket-facts = []
pull-request-facts = []
score-threshold = 90
[[task-types.review.transition.branches]]
when = "score-above-threshold"
ticket-facts = ["ready-to-ship"]
[[task-types.review.transition.branches]]
when = "score-below-threshold"
ticket-facts = ["needs-work"]

[task-types.rework]
template = '''Rework pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}'''
[task-types.rework.transition]
ticket-facts = ["ready-for-review"]
pull-request-facts = []

[task-types.merge]
template = '''Merge pull request {external-key}: {title}.

Repository: {repository}
Pull request: {source-url}'''
thinking = "low"
[task-types.merge.transition]
ticket-facts = []
pull-request-facts = []

[consultation-types.grill-with-docs]
agent = "codex"
environment = "live-worktree"
template = "/skill:grill-with-docs {input}"

# The states of the label workflow, in match order: the work that still has
# to happen outranks the work that is ready to happen on the same ticket.
[[states]]
name = "needs-work"
task-type = "rework"
[states.match]
source-kind = "github-issue"
labels-any = ["needs-work"]

[[states]]
name = "ready-for-review"
task-type = "review"
[states.match]
source-kind = "github-issue"
labels-any = ["ready-for-review"]

[[states]]
name = "ready-to-ship"
task-type = "merge"
[states.match]
source-kind = "github-issue"
labels-any = ["ready-to-ship"]

[[states]]
name = "ready-for-agent"
task-type = "implement"
[states.match]
source-kind = "github-issue"
labels-any = ["ready-for-agent"]

[[sources]]
name = "issues"
kind = "github-issues"
refresh-interval-seconds = 30
repositories = ["${REPO_A}", "${REPO_B}"]
`;
}

/** One search node, the shape the GraphQL query asks for. */
const ghNode = (ticket: FetchedTicket): Record<string, unknown> => ({
	__typename: "Issue",
	id: `I_fixture${ticket.externalKey.slice(1)}`,
	number: Number(ticket.externalKey.slice(1)),
	title: ticket.title,
	body: ticket.description,
	url: ticket.url,
	state: "OPEN",
	updatedAt: ticket.externalUpdatedAt,
	labels: { nodes: ticket.labels.map((name) => ({ name })) },
	repository: {
		name: ticket.repository.displayName.split("/")[1],
		nameWithOwner: ticket.repository.displayName,
		url: ticket.repository.cloneUrl.replace(/\.git$/, ""),
	},
});

/**
 * The `gh` stub: the ticket source's search queries, answered with one fixed
 * page per fixture repository. The source issues one query per repository,
 * and the stub matches the query's `repo:` qualifier to pick the page. Each
 * page is one single-quoted shell string, so the stub itself holds no quotes
 * of its own.
 */
const ghPage = (repository: string): string =>
	JSON.stringify({
		data: {
			search: {
				issueCount: TICKETS.filter((ticket) => ticket.repository.displayName === repository).length,
				pageInfo: { hasNextPage: false, endCursor: null },
				nodes: TICKETS.filter((ticket) => ticket.repository.displayName === repository).map(ghNode),
			},
		},
	});

const GH_STUB = [
	"#!/bin/sh",
	"# Screenshot stub for gh: one fixed search page per fixture repository,",
	"and the transition label writes, accepted.",
	"# Shell builtins only: the fixture PATH holds this bin dir and nothing else.",
	// A label write is a success: the plane reads no body of it.
	'[ "$1" = "issue" ] && exit 0',
	'[ "$1" = "pr" ] && exit 0',
	'[ "$1" = "api" ] || exit 1',
	"printed=0",
	'for a in "$@"; do',
	'  case "$a" in',
	`    *"repo:${REPO_A}"*) printf '%s' '${ghPage(REPO_A)}'; printed=1 ;;`,
	`    *"repo:${REPO_B}"*) printf '%s' '${ghPage(REPO_B)}'; printed=1 ;;`,
	"  esac",
	"done",
	'[ "$printed" = "1" ] || exit 1',
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
 * The `herdr` stub: three live panes. `pane-2` works the in-flight ticket and
 * reports working until the capture touches `done.flag`; `pane-3` holds the
 * working Consultation; `pane-4` is idle beside the Consultation that awaits
 * its answer. `pane-2` reports a session record: its settled turn reads its
 * log and its `completed` cause from it, so the plane fires the implement
 * transition on the settle.
 */
const HERDR_STUB = `#!/bin/sh
# Screenshot stub for herdr: the fixture's three live agent panes.
# Shell builtins only: the fixture PATH holds this bin dir and nothing else.
dir="\${0%/*}/.."
[ "$1" = "agent" ] || exit 1
case "$2" in
list)
  status="working"
  [ -f "$dir/done.flag" ] && status="done"
  printf '%s' '{"result":{"agents":[{"pane_id":"pane-2","tab_id":"tab-2","workspace_id":"ws-2","agent":"pi","checkout_path":"/home/seriousjul/src/my-little-software-factory","agent_session":{"kind":"path","value":"'
  printf '%s' "$dir"
  printf '%s' '/session.jsonl"},"agent_status":"'
  printf '%s' "$status"
  printf '%s' '"},{"pane_id":"pane-3","tab_id":"tab-3","workspace_id":"ws-3","agent":"codex","checkout_path":"/home/seriousjul/src/my-little-software-factory","agent_status":"working"},{"pane_id":"pane-4","tab_id":"tab-4","workspace_id":"ws-4","agent":"codex","checkout_path":"/home/seriousjul/src/pi-extensions","agent_status":"idle"}]}}'
  ;;
read)
  case "$3" in
  pane-2)
    printf '%s' '{"result":{"output":"${RUNNING_PANE_TEXT.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"}}'
    ;;
  pane-3)
    printf '%s' '{"result":{"output":"${CONSULTATION_PANE_TEXT.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"}}'
    ;;
  pane-4)
    printf '%s' '{"result":{"output":"${IDLE_PANE_TEXT.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"}}'
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

/**
 * Seed the state file: five tickets across two repositories, the ticket list
 * grouped by repository, one queue item, and two Consultations.
 */
function seedState(path: string, settingsHash: string): void {
	const state = openFactoryState(path, () => Date.parse(NOW));
	const source: SourceDefinition = { name: "issues", kind: "github-issues" };
	state.sourceFact.initializeSources([source]);
	state.sourceFact.applyFetch(source, { status: "success", fetchedAt: NOW, tickets: [...TICKETS] });
	// The guide screens stand on a world the operator has already initialized
	// (ADR 0075): both repositories carry an init fact at the world's own
	// settings hash, so the init marker stays off the Group headers and the
	// one-time note stays off the Message line, and the screens read as the
	// screens the guides show rather than as an init prompt.
	for (const repository of [REPO_A, REPO_B]) {
		state.repositoryInit.setRepositoryInitFact(
			`github.com/${repository.toLowerCase()}`,
			settingsHash,
			"fixture-init",
		);
	}

	// The in-flight ticket: claimed and started, its agent working in pane-2.
	const runningClaim = state.handoff.claimHandoff(
		RUNNING_TICKET.identity,
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
	state.handoff.settleHandoff(runningClaim.claim.attemptId, true, undefined, {
		paneId: "pane-2",
		tabId: "tab-2",
		workspaceId: "ws-2",
	});

	// The awaiting ticket: claimed, started, and its turn settled.
	const awaitingClaim = state.handoff.claimHandoff(
		AWAITING_TICKET.identity,
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
	state.handoff.settleHandoff(awaitingClaim.claim.attemptId, true, undefined, {
		paneId: "pane-1",
		tabId: "tab-1",
		workspaceId: "ws-1",
	});
	state.ticketWorkCycle.settleTurn({
		ticketIdentity: AWAITING_TICKET.identity,
		handoffId: awaitingClaim.claim.attemptId,
		taskType: "review",
		agentType: "pi",
		message: "The ranking change is reviewed: ranked tickets stay ahead of unranked ones.",
		turnLog: [...TURN_LOG],
		cause: "completed",
		completedAt: NOW,
		// The review transition the plane fired on this completed turn: the
		// score branch wrote the ship fact, and the machine re-derived the
		// merge position on the written labels.
		transition: {
			fired: true,
			when: "score-above-threshold",
			reason: "",
			ticketFacts: ["ready-to-ship"],
			pullRequestFacts: [],
			ticketWrite: { added: ["ready-to-ship"], removed: ["ready-for-agent"] },
			pullRequestWrite: null,
			pullRequestIdentity: null,
			pullRequestKey: null,
			writeFailure: "",
			positionTaskType: "merge",
			positionTicketIdentity: AWAITING_TICKET.identity,
		},
	});

	// The pi-extensions ticket that waits in the Work queue (ADR 0049): the
	// queue holds the start, and the ticket's row wears the `queued` badge
	// under the open state. The queue pause (ADR 0052) holds the drain, so
	// the item stands in the queue for the shot instead of its pickup trying
	// to start it on the boot pass.
	state.workQueue.setQueuePaused(true);
	const queued = state.workQueue.enqueueWork({
		ticketIdentity: SKILL_INDEX_TICKET.identity,
		origin: "open",
		choice: {
			agentType: "pi",
			environment: "live-worktree",
			taskType: "implement",
			model: "anthropic/claude-sonnet-4-5",
			thinking: "medium",
			contextWindow: "",
		},
		previousMessage: "",
	});
	if (!queued.ok) throw new Error(`fixture: queue item: ${queued.reason}`);

	// The grouping axis the operator chose (ADR 0058): the ticket list splits
	// by repository, so the two repositories stand as two Groups.
	state.grouping.setGroupingAxis("tickets", "repository");

	// The working Consultation: launched, its agent working in pane-3.
	const retryConsultation = state.consultationRecord.createConsultation({
		typeName: "grill-with-docs",
		agentType: "codex",
		environment: "live-worktree",
		template: "/skill:grill-with-docs {input}",
		initialInput: "The webhook retry policy: who owns the retry budget across an agent restart?",
		renderedOpeningPrompt:
			"/skill:grill-with-docs The webhook retry policy: who owns the retry budget across an agent restart?",
		repository: {
			identity: `github.com/${REPO_A.toLowerCase()}`,
			displayName: REPO_A,
			cloneUrl: `${REPO_A_URL}.git`,
			path: "/home/seriousjul/src/my-little-software-factory",
		},
		agentName: "consult-retry-budget",
		createdAt: NOW,
	});
	state.consultationRecord.setConsultationAgent(retryConsultation.id, {
		paneId: "pane-3",
		tabId: "tab-3",
		workspaceId: "ws-3",
	});

	// The Consultation that awaits its answer: its agent is idle in pane-4,
	// and the section header's attention count reads it.
	const indexConsultation = state.consultationRecord.createConsultation({
		typeName: "grill-with-docs",
		agentType: "codex",
		environment: "live-worktree",
		template: "/skill:grill-with-docs {input}",
		initialInput:
			"The skill index: should find-skills store paths to local skills, or copies of them?",
		renderedOpeningPrompt:
			"/skill:grill-with-docs The skill index: should find-skills store paths to local skills, or copies of them?",
		repository: {
			identity: `github.com/${REPO_B.toLowerCase()}`,
			displayName: REPO_B,
			cloneUrl: `${REPO_B_URL}.git`,
			path: "/home/seriousjul/src/pi-extensions",
		},
		agentName: "consult-skill-index",
		createdAt: NOW,
	});
	state.consultationRecord.setConsultationAgent(indexConsultation.id, {
		paneId: "pane-4",
		tabId: "tab-4",
		workspaceId: "ws-4",
	});
	state.consultationRecord.setConsultationState(indexConsultation.id, "awaiting-response");
	state.close();
}

/** Write the fixture world into a fresh directory and return its path. */
export function buildFixture(root: string): string {
	const dir = mkdtempSync(join(root, "factory-screenshots-"));
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFileSync(join(dir, "config.toml"), configToml(dir));
	// The herdr config the plane's theme path reads: the fixture world stands
	// inside a herdr pane (the capture sets HERDR_ENV), so the plane resolves
	// its theme the way a live run does (ADR 0024), on the theme the
	// operator's herdr stands on.
	const herdrConfigDir = join(dir, ".config", "herdr");
	mkdirSync(herdrConfigDir, { recursive: true });
	writeFileSync(
		join(herdrConfigDir, "config.toml"),
		`onboarding = false\n\n[theme]\nname = "${HERDR_THEME_NAME}"\n`,
	);
	// The in-flight agent's session record: one completed turn, stamped on the
	// fixture clock so the staleness guard reads it as this run's. The
	// settled turn's log and its `completed` cause come from it.
	writeFileSync(
		join(dir, "session.jsonl"),
		`${JSON.stringify({
			type: "message",
			timestamp: NOW,
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: "The retry queue is implemented: failed deliveries retry with a bounded backoff and give up after the third attempt.",
					},
				],
			},
		})}\n`,
		"utf8",
	);
	writeFileSync(join(dir, "bin", "gh"), GH_STUB);
	writeFileSync(join(dir, "bin", "pi"), PI_STUB);
	writeFileSync(join(dir, "bin", "herdr"), HERDR_STUB);
	for (const name of ["gh", "pi", "herdr"]) chmodSync(join(dir, "bin", name), 0o755);
	// The world's own settings hash, so the init facts it seeds match the
	// config the plane will load from the same file (ADR 0075): the fixtures'
	// repositories stand initialized, not drifted, on the screen the guide shows.
	const worldConfig = validateConfig(parse(configToml(dir)));
	seedState(
		join(dir, "state.sqlite"),
		repositoryInitSettingsHash(worldConfig.workflowStates, worldConfig.taskTypes),
	);
	return dir;
}

/**
 * The screen the walk drives: the cursor's row, the cursor's row index, the
 * whole screen text, and the key write.
 *
 * The walk is pure over this seam, so the unit test drives it with a fake
 * screen and a fake clock instead of a PTY: the reproduction of the load
 * flake holds the fake screen's repaint, and the walk has to win that race
 * on the frame, not on a sleep.
 */
export interface ScreenWalk {
	/**
	 * The row the keyboard cursor holds, read from one frame parse: the row's
	 * index and the full text of the row under the cursor.
	 *
	 * The index and the text come from the same parse, so the two can never
	 * describe different frames. The index is the walk's move predicate: a
	 * row can repaint in place (the Starting window's spinner face ticks)
	 * while the cursor holds it, and that repaint is not a move. The text is
	 * the walk's match.
	 *
	 * A frame caught mid-redraw reports -1 and "": a section transition
	 * leaves the box's border and the cursor mark briefly undrawn. The walk
	 * must not read that frame as a move.
	 */
	cursorRow(): { index: number; text: string };
	/** The whole screen, as parsed lines. */
	gridText(): string;
	/** Write input bytes, as the host terminal would. */
	key(bytes: string): void;
}

/** The walk's frame poll, the harness's own poll interval. */
const STEP_POLL_MS = 10;
/**
 * How long one press's frame wait may run before the press is read dropped.
 *
 * The keyboard is live once the screen settles, and a live cursor moves
 * within a fraction of that: a press that has not moved the cursor's row
 * by this deadline did not land, and the walk presses again. The press is
 * not charged to the step budget, because the screen spent no row on it.
 */
export const PRESS_DEADLINE_MS = 1000;
/**
 * How long the whole walk may run before the capture fails.
 *
 * The deadline fails the capture with the screen as it stands, the way
 * the harness's frame wait fails at its deadline: a screen whose cursor
 * never moves still fails the walk, only at this deadline. The harness's
 * frame deadline doubles in CI, where the shared runners run the suite
 * under load, and the walk takes the same doubling: a loaded runner gets
 * a loaded walk, not a local one.
 */
export const WALK_DEADLINE_MS = process.env.CI ? 20000 : 10000;

/**
 * The cursor's row once two polls a frame apart agree on it.
 *
 * A single frame read can catch the screen mid-redraw: a section
 * transition leaves the box's border and the cursor mark briefly undrawn,
 * and the read reports -1. One such read is not a move - the walk acts
 * only on a row the next poll confirms, so a single glitch frame can
 * neither read a move that did not happen nor hide one that did.
 *
 * A pair that agrees on -1 is not a stable row: a glitch window that
 * spans two polls would hand the mid-redraw frame to the walk, and the -1
 * index would read as a move against whatever real row stands before it -
 * a dropped press meeting its first confirmed real row, or a real row
 * meeting a confirmed -1. The pair is accepted only on a real row, so a
 * screen that stands mid-redraw for the whole deadline fails at the
 * walk's deadline, the way a screen whose cursor never moves does.
 */
async function stableCursorRow(
	screen: ScreenWalk,
	sleepFn: (ms: number) => Promise<void>,
	now: () => number,
	walkDeadline: number,
	failure: () => Error,
): Promise<{ index: number; text: string }> {
	let previous = screen.cursorRow();
	for (;;) {
		if (now() >= walkDeadline) throw failure();
		await sleepFn(STEP_POLL_MS);
		const current = screen.cursorRow();
		if (current.index >= 0 && current.index === previous.index) return current;
		previous = current;
	}
}

/**
 * Step one row at a time until the cursor holds a row that carries the
 * match, so the walk holds its aim across the Group headers, the blank
 * row between Groups, and the section borders without counting rows.
 *
 * The walk waits on the frame, not on the clock: after each press it polls
 * until the cursor's row moves, and fails at the walk's deadline, the way
 * the suite's frame wait does. A fixed sleep after a press is the defect
 * this replaces - on a loaded runner the repaint can land later than the
 * sleep, and the next step read the frame the previous press had not yet
 * painted, so a late repaint spent a step of the budget.
 *
 * The frame can also lie in the other direction: a repaint in flight
 * leaves one frame mid-redraw (the border or the mark undrawn), and a
 * frame one press behind the screen is a late repaint, not a standstill.
 * The walk reads both the cursor's row index and its row text from one
 * parse, and acts only on a row two polls confirm: a glitch frame neither
 * reads as a move nor as the match, and a press counts as landed only when
 * the confirmed row says the cursor moved. That is what keeps the walk's
 * press count equal to the screen's cursor position, the invariant a
 * stale read breaks - with it, the next key the capture presses lands on
 * the row the frame shows, not one the screen has already crossed.
 *
 * A press that the screen never paints is read dropped - the boot window
 * swallows a key the list has not yet taken - and the walk presses again
 * without charging the step. `maxSteps` is a statement about the screen,
 * not about time: it counts rows, every counted press having moved the
 * cursor one row on the frame. A Group header the cursor has to cross is
 * a row the budget says so.
 */
export async function stepUntilRow(
	screen: ScreenWalk,
	match: string,
	keyName: string,
	maxSteps: number,
	sleepFn: (ms: number) => Promise<void> = sleep,
	now: () => number = Date.now,
): Promise<void> {
	const walkDeadline = now() + WALK_DEADLINE_MS;
	const failure = () =>
		new Error(
			`screenshots: the cursor never reached a row matching "${match}" within ${maxSteps} "${keyName}" steps\n${screen.gridText()}`,
		);
	const stable = () => stableCursorRow(screen, sleepFn, now, walkDeadline, failure);
	const holdsMatch = (row: { index: number; text: string }) =>
		row.index >= 0 && row.text.includes(match);
	for (let steps = 0; steps < maxSteps; steps++) {
		if (holdsMatch(await stable())) return;
		let before = await stable();
		screen.key(keyName);
		let pressDeadline = now() + PRESS_DEADLINE_MS;
		for (;;) {
			const row = await stable();
			if (row.index !== before.index) break;
			if (holdsMatch(row)) return;
			if (now() >= pressDeadline) {
				// The press did not land: the confirmed row never moved.
				// Press again; the row the screen has not spent is not
				// charged to the step budget.
				before = row;
				screen.key(keyName);
				pressDeadline = now() + PRESS_DEADLINE_MS;
			}
		}
	}
	if (!holdsMatch(await stable())) throw failure();
}

/**
 * Walk one PTY session through the six screens and return each as a PNG.
 *
 * The session accumulates bytes; each capture renders the stream so far into
 * the grid the PTY holds, so a capture is the screen as it stands then. The
 * cursor starts on the first row, the first Group's header, so the walk steps
 * with `j` and `k` and settles each stop on the text the Detail pane shows
 * for the row the cursor holds.
 */
export async function captureScreens(fixtureDir: string): Promise<Map<string, Buffer>> {
	const out = new Map<string, Buffer>();
	const session = await openControlPlanePty(
		["--config", join(fixtureDir, "config.toml")],
		{
			// The mark of a herdr child pane (ADR 0024): with it, the plane
			// resolves its theme from the herdr config the fixture holds.
			HERDR_ENV: "1",
			// The color half of the pair herdr gives every pane (ADR 0123):
			// with it, the plane writes the Theme's exact hex in the stream.
			COLORTERM: "truecolor",
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
		await session.waitForStable(300, `the screen to settle before ${name}`, 15000);
		const grid = parseScreen(session.output(), SCREEN.cols, SCREEN.rows);
		out.set(name, renderPng(grid, TERMINAL_COLORS));
	};
	const key = (bytes: string) => {
		session.write(bytes);
	};
	// The parsed grid, as lines. The raw stream accumulates every redraw, so
	// a cursor question must be asked of the screen as it stands, not of the
	// bytes it ever held.
	const gridText = (): string =>
		parseScreen(session.output(), SCREEN.cols, SCREEN.rows)
			.map((row) => row.map((cell) => cell.char).join(""))
			.join("\n");
	// The row the keyboard cursor holds, as one parse: the index and the
	// text from the same frame. Every section's list keeps its own
	// remembered cursor mark, so the mark alone does not name the keyboard's
	// row: the keyboard's row is the mark inside the box whose border
	// carries the section-focus mark. A frame mid-redraw shows no border or
	// no mark, and reports -1 with no text.
	const cursorRow = (): { index: number; text: string } => {
		const rows = gridText().split("\n");
		const border = rows.findIndex((line) => line.includes("─❯"));
		if (border === -1) return { index: -1, text: "" };
		for (let i = border + 1; i < rows.length; i++) {
			const line = rows[i];
			if (line.startsWith("└")) break;
			if (line.includes("❯")) return { index: i, text: line.replace("❯", " ").trim() };
		}
		return { index: -1, text: "" };
	};
	const screen: ScreenWalk = { cursorRow, gridText, key };

	try {
		// 1. The Main view, once the fetch lands its tickets and the observation
		// marks the in-flight one running. One step down from the first Group's
		// header, onto the ticket awaiting a decision.
		await session.waitFor(
			(data) => data.includes("open: 3  running: 1  awaiting: 1"),
			"the full ticket list",
			30000,
		);
		log("main view ready");
		// Settle before the walk's first press: the keyboard is live when the
		// screen settles, and a press in the boot window the list has not yet
		// taken is swallowed, not queued.
		await session.waitForStable(200, "the main view settle", 15000);
		// The budget counts rows: the header the cursor starts on, the two
		// rows above the target, the target itself.
		await stepUntilRow(screen, "Rank tickets by priori", "j", 3);
		await capture("main-view");

		// 2. The Override panel on the open ticket.
		await stepUntilRow(screen, "Split the README into", "j", 4);
		key("e");
		log("pressed e for the override panel");
		await session.waitFor((data) => data.includes("Task type"), "the override panel", 15000);
		// Let the model list query settle so the Model row shows its value.
		await sleep(800);
		await session.waitForStable(400, "the override panel to settle", 15000);
		await capture("override-panel");
		log("override panel captured");
		key("\x1b");
		await sleep(250);

		// 3. The decision modal on the awaiting ticket: Enter on it is Decide,
		// and the modal opens with the turn log as its body.
		await stepUntilRow(screen, "Rank tickets by priori", "k", 4);
		key("\r");
		log("pressed Enter for the decision modal");
		await session.waitFor((data) => data.includes("Decision: "), "the decision modal", 15000);
		await capture("decision-modal");
		key("\x1b");
		await sleep(250);

		// 4. The working Consultation: step down through the ticket section and
		// the blank row between Groups, into the Consultations section, until
		// the detail pane shows its input.
		log("moving into the consultations section");
		await stepUntilRow(screen, "working", "j", 8);
		await sleep(1200);
		await capture("consultation");

		// 5. The Live view on the in-flight ticket: step up to it, and Enter
		// opens the agent's stream in the left box.
		await stepUntilRow(screen, "Retry failed webhook", "k", 8);
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
		// label appears: the awaiting ticket's modal offers the merge position.
		await session.waitFor((data) => data.includes("Handoff: review"), "the settled turn", 30000);
		await sleep(400);
		await session.waitForStable(400, "the turn-log screen to settle", 15000);
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
