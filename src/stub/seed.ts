/**
 * The seed of the Stub run (issue #178, ADR 0073).
 *
 * The seed is the repeatable walk: the world file with its scenario tickets
 * and its merge gate facts, and the stub configuration that runs against it.
 * The seed files live in the repository, and the seed script recreates the
 * local checkouts and the world file from scratch, so a walk is repeatable
 * and a broken world is disposable.
 *
 * The seed pre-provisions the linked pull request of each scenario issue:
 * the closing reference in the body and the factory branch prefix on the
 * head branch, open, no workflow label. No pull request is auto-created on
 * turn settle. The pre-provisioned pull requests stand as drafts: a listed,
 * non-draft fixing pull request covers its open issue and the issue exits
 * the list, which would make the implement handoff of the scenario
 * unreachable. A draft is not listed by the default pull request policy, so
 * the issue stands in the Ticket section as it does in the live factory;
 * the walk undrafts the pull request and re-fires the recorded skip, the
 * same route the #148 walk walked in the live factory.
 */
import type { StubWorld } from "./world.ts";

/** The host the stub configuration and the world agree on. */
export const STUB_HOST = "github.com";
/** The owner the world's repositories sit under. */
export const STUB_OWNER = "stub";

/** The time the seed's items stand at, so the seed's ordering is fixed. */
const SEED_TIME = "2026-09-30T00:00:00.000Z";

const minutes = (count: number) => new Date(Date.parse(SEED_TIME) + count * 60_000).toISOString();

/**
 * The world the walk starts from: two repositories with their scenario
 * issues, their linked draft pull requests, their merge gate facts, and
 * their security feed items. A fresh document on every call: the seed holds
 * no shared mutable state.
 */
export function stubWorldSeed(): StubWorld {
	return {
		version: 1,
		host: STUB_HOST,
		owner: STUB_OWNER,
		autoScore: { enabled: true, score: 92 },
		repositories: [
			{
				name: "alpha",
				issues: [
					{
						number: 1,
						title: "Add a greeting command",
						body: "Greet the operator by name.",
						labels: ["ready-for-agent"],
						state: "open",
						updatedAt: minutes(0),
					},
					{
						number: 2,
						title: "Fix the greeting punctuation",
						body: "The greeting ends without a period.",
						labels: [],
						state: "open",
						updatedAt: minutes(5),
					},
				],
				pullRequests: [
					{
						number: 1,
						title: "Add a greeting command",
						body: "Add the greeting command.\n\nFixes #1",
						labels: [],
						state: "open",
						merged: false,
						draft: true,
						headBranch: "factory/1-add-a-greeting-command",
						closingIssueNumbers: [1],
						comments: [],
						reviews: [],
						updatedAt: minutes(10),
					},
				],
				mergeGates: { "1": { passing: true, reason: "" } },
				security: {
					advisories: [
						{
							ghsa_id: "GHSAA-STUB-ALPHA",
							summary: "The stub advisory for alpha",
							state: "published",
							severity: "moderate",
							description: "A stub vulnerability with no real exposure.",
							vulnerabilities: [
								{
									package: { ecosystem: "npm", name: "stub-package" },
									vulnerable_version_range: "< 1.1.0",
									first_patched_version: "1.1.0",
								},
							],
							html_url: `https://${STUB_HOST}/${STUB_OWNER}/alpha/security/advisories/GHSAA-STUB-ALPHA`,
							updated_at: minutes(15),
						},
					],
					dependabotAlerts: [],
					secretScanningAlerts: [
						{
							id: 1,
							number: 1,
							state: "open",
							html_url: `https://${STUB_HOST}/${STUB_OWNER}/alpha/security/secret-scanning/alerts/1`,
							secret_type: { name: "AWS access token" },
							location: { file: "config/stub.toml", start_line: 3, end_line: 3 },
							updated_at: minutes(20),
							created_at: minutes(20),
						},
					],
				},
			},
			{
				name: "beta",
				issues: [
					{
						number: 1,
						title: "Add a farewell command",
						body: "Say goodbye to the operator by name.",
						labels: ["ready-for-agent"],
						state: "open",
						updatedAt: minutes(25),
					},
					{
						number: 2,
						title: "Tune the farewell pacing",
						body: "The farewell is too fast.",
						labels: ["ready-for-agent"],
						state: "open",
						updatedAt: minutes(30),
					},
				],
				pullRequests: [
					{
						number: 1,
						title: "Add a farewell command",
						body: "Add the farewell command.\n\nFixes #1",
						labels: [],
						state: "open",
						merged: false,
						draft: true,
						headBranch: "factory/1-add-a-farewell-command",
						closingIssueNumbers: [1],
						comments: [],
						reviews: [],
						updatedAt: minutes(35),
					},
					{
						number: 2,
						title: "Tune the farewell pacing",
						body: "Slow the farewell down.\n\nFixes #2",
						labels: [],
						state: "open",
						merged: false,
						draft: true,
						headBranch: "factory/2-tune-the-farewell-pacing",
						closingIssueNumbers: [2],
						comments: [],
						reviews: [],
						updatedAt: minutes(40),
					},
				],
				mergeGates: {
					"1": { passing: false, reason: "the stub CI gate is failing the build" },
					"2": { passing: true, reason: "" },
				},
				security: {
					advisories: [],
					dependabotAlerts: [
						{
							number: 1,
							state: "open",
							html_url: `https://${STUB_HOST}/${STUB_OWNER}/beta/security/dependabot/1`,
							manifest_path: "package.json",
							scope: "package.json",
							relationship: "direct",
							security_advisory: {
								cve_id: "CVE-2026-00001",
								ghsa_id: "GHSAA-STUB-BETA",
								summary: "The stub dependency vulnerability",
								severity: "high",
								description: "A stub vulnerability in the stub dependency.",
							},
							security_vulnerability: {
								package: { ecosystem: "npm", name: "stub-dependency" },
								vulnerable_version_range: "< 2.0.0",
								first_patched_version: "2.0.0",
							},
							updated_at: minutes(45),
							created_at: minutes(45),
						},
					],
					secretScanningAlerts: [],
				},
			},
		],
	};
}

/**
 * The stub configuration that runs against the world: the stub owner's
 * repositories at the seeded local checkouts, no auth on any source, two
 * parallel seats, the auto-handoff off so the operator confirms every
 * handoff, trivial one-line prompt templates that keep the external key and
 * title line, and a separate state file and a separate log file.
 */
export function renderStubConfig(stubDir: string): string {
	const checkout = (name: string) => `${stubDir}/checkouts/${name}`;
	return `# The Stub run configuration (issue #178, ADR 0073). It runs the real
# control plane against the Stub world: no auth on any source, the stub
# owner's repositories at the seeded local checkouts, and the trivial
# one-line prompt templates that keep the external key and title line, so
# the ticket and the pull request stay linkable.
state-file = ".factory-stub.sqlite"
default-agent = "pi"
default-environment = "worktree"
default-task-type = "implement"
attention-bell = true
interaction-exit-key = "f12"
max-parallel-agents = 2
agent-poll-interval-seconds = 5
completion-message-lines = 200
max-handoffs-per-ticket = 20

[repos]
"${STUB_HOST}/${STUB_OWNER}/alpha" = "${checkout("alpha")}"
"${STUB_HOST}/${STUB_OWNER}/beta" = "${checkout("beta")}"

[scroll]
speed = 1
acceleration = 0.8
maximum-speed = 6

[logging]
level = "debug"
file = ".factory-stub.log"
max-size-mib = 10
keep = 5

[agents.pi]
kind = "pi"

[consultation-types.trivial]
agent = "pi"
template = "Say OK to this: {input}"

# --- The workflow machine (ADR 0027), the stub walk's copy ------------------

[[states]]
name = "ready-for-agent"
task-type = "implement"
[states.match]
source-kind = "github-issue"
labels-any = ["ready-for-agent"]

[[states]]
name = "needs-work"
task-type = "rework"
[states.match]
source-kind = "github-pull-request"
labels-any = ["needs-work"]

[[states]]
name = "ready-for-review"
task-type = "review"
[states.match]
source-kind = "github-pull-request"
labels-any = ["ready-for-review"]

[[states]]
name = "ready-to-ship"
task-type = "merge"
[states.match]
source-kind = "github-pull-request"
labels-any = ["ready-to-ship"]

[[states]]
name = "security-advisory"
task-type = "resolve-security-advisory"
[states.match]
source-kind = "github-security-advisory"

[[states]]
name = "security-dependabot-alert"
task-type = "resolve-dependabot-alert"
[states.match]
source-kind = "github-dependabot-alert"

[[states]]
name = "security-secret-alert"
task-type = "resolve-secret-scanning-alert"
[states.match]
source-kind = "github-security-secret-alert"

[[states]]
name = "pull-request-unlabeled"
[states.match]
source-kind = "github-pull-request"
labels-none = ["needs-work", "ready-for-review", "ready-to-ship"]

# --- The task types: trivial one-line templates that keep the external key
# and the title line, so the ticket and the pull request stay linkable.

[task-types.implement]
template = "Do the work: {external-key}: {title}"
[task-types.implement.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]

[task-types.review]
template = "Review {external-key}: {title}. Post the score line."
[task-types.review.transition]
ticket-facts = []
pull-request-facts = []
score-threshold = 90
[[task-types.review.transition.branches]]
when = "score-above-threshold"
pull-request-facts = ["ready-to-ship"]
[[task-types.review.transition.branches]]
when = "score-below-threshold"
pull-request-facts = ["needs-work"]

[task-types.rework]
template = "Rework {external-key}: {title}. Post a summary comment."
[task-types.rework.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]

[task-types.merge]
action = "merge-pull-request"
method = "squash"
[task-types.merge.transition]
ticket-facts = []
pull-request-facts = []
[[task-types.merge.transition.branches]]
when = "pull-request-open"
pull-request-facts = ["needs-work"]
[[task-types.merge.transition.branches]]
pull-request-facts = []

[task-types.resolve-security-advisory]
template = "Resolve {external-key}: {title}. Open a pull request."
[task-types.resolve-security-advisory.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]
auto-advance = true

[task-types.resolve-dependabot-alert]
template = "Resolve {external-key}: {title}. Open a pull request."
[task-types.resolve-dependabot-alert.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]
auto-advance = true

[task-types.resolve-secret-scanning-alert]
template = "Resolve {external-key}: {title}. Open a pull request."
[task-types.resolve-secret-scanning-alert.transition]
ticket-facts = []
pull-request-facts = ["ready-for-review"]
auto-advance = true

[[sources]]
name = "stub-issues"
kind = "github-issues"
refresh-interval-seconds = 60
repositories = ["${STUB_OWNER}/alpha", "${STUB_OWNER}/beta"]
host = "${STUB_HOST}"

[[sources]]
name = "stub-pull-requests"
kind = "github-pull-requests"
refresh-interval-seconds = 60
repositories = ["${STUB_OWNER}/alpha", "${STUB_OWNER}/beta"]
host = "${STUB_HOST}"

[[sources]]
name = "stub-security-advisories"
kind = "github-security-advisories"
refresh-interval-seconds = 300
repositories = ["${STUB_OWNER}/alpha", "${STUB_OWNER}/beta"]
host = "${STUB_HOST}"

[[sources]]
name = "stub-dependabot-alerts"
kind = "github-dependabot-alerts"
refresh-interval-seconds = 300
repositories = ["${STUB_OWNER}/alpha", "${STUB_OWNER}/beta"]
host = "${STUB_HOST}"

[[sources]]
name = "stub-secret-alerts"
kind = "github-secret-scanning-alerts"
refresh-interval-seconds = 300
repositories = ["${STUB_OWNER}/alpha", "${STUB_OWNER}/beta"]
host = "${STUB_HOST}"
`;
}
