# ADR 0073: The Stub run serves GitHub from the Command runner seam

Status: accepted
Date: 2026-09-30

## Context

The control plane's whole external I/O passes through the Command runner:
every herdr, git, GitHub CLI, and agent model list command. The automated
tests inject a fake at that seam, so no test touches a real session,
repository, ticket source, or agent runtime.

The acceptance walk that followed the workflow machine (the verification
record for issue #148) ran the production executable with a real state
database, a live github-issues source, and a shadowed `herdr` so the
observation loop holds. That walk proved the TUI and the machine against
real GitHub facts. The agent side was shadowed: no real agent work, no Live
view of a real turn, no turn log from a real session record.

The operator's walk needs the other half. They want to play the human side
of the flow: the handoff, the turn, the decision, the merge, across
several repositories, with a real agent, at the speed of a conversation.
The long pole of the real factory's flow is the agent's own work, a turn
that runs for minutes to hours. A walk that waits for real work is a wait,
not a walk.

The question was which side to stub, and where to put the boundary.

## Decision

The Stub run is a control plane run that the production entry starts with
the real child process runner wrapped in a runner that serves only the
`gh` commands from a Stub world and passes every other command to the real
binaries. The boundary is the existing Command runner seam, not a new one.
The TUI, the state file, the workflow machine, the observation, the
handoff, and the source modules stay unchanged, and only the startup
wiring learns that a stub is in play.

Only `gh` is stubbed. `git`, `herdr`, and the agent CLIs run for real. The
Stub run is the mirror image of the issue #148 walk, which kept GitHub
live and shadowed herdr, and the two are complementary: together they cover
both halves of the external world.

The Stub world is a JSON file, and it is the source of truth of the stub
side. The plane's own label writes, merges, and comments mutate it with
write-through, and a restart reads it back. The run re-reads the file before
every answer, so a world CLI or hand edit made between commands stands on
the run's next command, and a write-through does not clobber an edit that
landed before the run read the file. The seed is the world's
initial content, and the seed script creates the local checkouts besides
it: small git repositories with no origin, for which the worktree base
falls back to the checkout's HEAD.

The world answers the closed `gh` surface the plane issues: the GraphQL
search the sources fetch, the comments and reviews reads the score
judgment walks, the pull request record read the open and merged judgment
takes, the issue and pull request edits the transitions write, the merge
and the blocked comment the plane action runs, and the auth token only
when a source names an auth, which the stub configuration does not.

The world carries a merge gate fact per pull request, and the answer to
the merge command follows it. A failing gate returns a GitHub-style
refusal, so the blocked outcome, the blocked comment, and the transition
back to the needs-work state run on the real code paths.

The world carries an auto score posting rule: the first comment read on a
pull request that carries no verdict posts the configured score. With the
rule on, the review transition fires in one settle, the way the real
agent's post does. The rule is a per-world setting, and the manual post
stays possible, so the no-score settle and the re-fire route stay
walkable.

The stub modules live in the product source, the gallery's precedent for a
development surface driven from the real entry, not a separate script.

## Considered options

Shadow herdr and keep GitHub live, the issue #148 walk, extended. That
direction proves the machine against real facts, but it keeps the agent
side fake, and the operator's walk needs a real agent, a Live view, a turn
log, and the missing-agent and recovery flows at stub speed. Rejected for
this purpose; it stays the complementary record for the real host.

Stub at the ticket source interface and leave the writes live. The source
is one seam, but the transition's label writes, the score read, the pull
request record read, and the plane action's merge all exit through the
same runner and would reach a real GitHub. A source-level stub cannot
serve a closed world. Rejected.

A separate entry that rewires the renderer for the stub. A second boot
path duplicates the production startup, and the duplication drifts: the
walk must prove the production boot, not a twin of it. Rejected in favor
of a flag on the real entry.

A TOML world file, the operator's native format. No TOML writer stands in
the dependency set, and the world is written on every mutation by the
running plane. JSON keeps the write-through exact and the file hand
editable. Rejected in favor of JSON.

An auto-created pull request on turn settle. The stub would have to map a
settling pane to a ticket, and the mapping is a hidden coupling to the
prompt text and the naming rule. The pre-provisioned linked pull request
in the seed, beside the operator's CLI verb, covers the same walk with no
magic. Rejected.

## Consequences

The acceptance walk gets a real agent under the Live view, a turn log from
a real session record, the Missing modal, and the recovery panel, at stub
speed, across a multi-repository world.

The stub side is not proof of real GitHub behavior. The label write
semantics, the search index latency, and the merge checks stand as the
world says they are. The issue #148 walk stays the record for the real
host, and this ADR adds nothing to it.

The dirty worktree close is the common path of a Stub run: the idle agent
leaves files in its worktree, so the force close is the usual close.
Verified on herdr 0.9.1 on 2026-09-30: a spike ran a real pi agent in a
no-origin local checkout from worktree create through prompt to settle to
read, and the removal needed the force flag.

The world file is read by the running plane on every command, written by it
with write-through, and edited by the operator's CLI and by hand. A write
that lands between the run's read and its own write-through is overwritten:
concurrent writers are not supported, and the walk is one operator.

The `gh` surface the world must answer is closed and small. A plane change
that adds a new `gh` command must extend the world, and a test that walks
the real command shapes pins the fact.
