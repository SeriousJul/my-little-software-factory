# The plane owns the workflow machine and its label transitions

Status: accepted
Date: 2026-09-15

## Context

The label workflow's state machine stands on prose in the prompt templates.
The task templates tell the agents which workflow labels to add and remove,
and the control plane reads labels through task rules to suggest the next
task. Issue #70 records the failure this invites: the implement agent put
`ready-to-ship` on a pull request that no review had seen, and the pull
request became merge-eligible while it silently never entered the review
queue. Prose cannot enforce a state machine; a template fix lowers the
failure rate and does not remove the failure mode.

The control plane already owns half of the routing: task rules read labels
and suggest task types, and workflow edges route a settled turn to the next
task type. What it does not own is the label flip itself. The documented
principle "the control plane reads labels. It never creates, removes, or
changes them" keeps the plane read-only, and it leaves the other half of the
state machine to model behavior.

## Decision

**The workflow machine lives in the config file.** One machine, an ordered
set of **states**. A state carries a name, a match condition (source name,
source kind, repository, label sets all, any, none), and an optional task
type. A ticket's position in the machine is derived from its source facts on
every refresh and never stored. A state that offers no task is a parking
state: the control plane does nothing on it, and an external label write is
the only engine that moves the ticket.

**A task type is work only**: its prompt template and its task profile. The
completion behavior, the **transition**, hangs off the task type: the label
facts a completed turn of it writes, on the ticket and on its linked pull
request. A transition can branch on a **judgment** (in the shipped machine:
the review score against the configured threshold, and whether the linked
pull request is still open), and it carries the auto-advance flag and the
agent and environment pins.

**The transition names no destination.** The labels are the states. The
transition writes the labels, and the machine re-derives every position from
the written labels; a named destination would be a second source of truth
that can drift from the labels it describes.

**The transition fires only on a `completed` settle**, before the completion
decision, in manual mode and in auto mode alike, and it is idempotent. After
it runs, the label set matches its spec whatever the agents or humans wrote
before. The plane's own write stands as fact until the next refresh. Writing
labels through the command runner is the plane's first write path to an
external source.

**The plane owns only the labels its writes name.** A write removes only a
label a transition or branch writes somewhere in the config, that the write's
own facts do not name. A label a state match names in its all or any set but
that no transition writes - the operator's scoping label, such as a
`labels-all = ["factory"]` gate - is never removed by a fire, so a state that
scopes on an operator label keeps the label it matched on. A write also runs
as the source the item lists on: the source's `auth` table resolves to the
credential the `gh edit` carries, so the plane's writes and its reads come
from the same account. A label a transition writes must already exist in the
repository: a write that names a missing label fails, and the fire records
the failure as a fact instead of routing.

**The linked pull request is found in the plane's own ticket list**, through
the issue references the pull request tickets already carry (ADR 0023),
after a forced refresh of the pull request source. The newest non-draft
wins. No pull request found is a visible fact: no pending record, no
automatic retry, and the completion decision proceeds as usual.

**Task rules and the old workflow edges are retired.** The suggested task
type is the task of the first matching state, else the default task type.
The new seed carries the machine and clean templates with no label
instructions; the agents stop writing workflow labels.

**The migration is a one-time full rewrite** at config load for installs
that carry the old workflow keys: rules become states, expressible edges
become transitions, the four seed templates are replaced on exact match (a
customized template is left untouched and named in the report), inexpressible
edges are dropped and each named in a one-time operator-readable report, the
old file is backed up to `config.toml.bak`, and any failure stops the plane
before any write. After the migration the loader is strict: an old key is a
config error that points at the backup.

The alternatives considered in the discussion (issue #70):

- **Gate, plane stays read-only (option B).** Before handing off a merge,
  the plane verifies through the GitHub API that the pull request has a
  qualifying review. Rejected: cheaper, but the rest of the state machine
  still stands on prose, and a bad label write still skips review.
- **External enforcement (option D).** A GitHub-side check that strips
  `ready-to-ship` from pull requests without a review. Rejected: zero app
  change, but repo-specific, the correction lags the bad write, and the
  state machine still stands on prose.
- **Fixed transitions in plane code (option C as first framed).** The plane
  applies a hard-coded set of label transitions. Superseded: hard-coding the
  label workflow into the plane leaves the operator no way to define their
  own workflow, and every new workflow becomes a code change.
- **State-keyed transitions.** The transition hangs off the state whose task
  settled. Rejected: a ticket that takes a task from the default task type,
  matching no state, never fires the transition, and the auto-handoff loop
  dies for every unlabeled issue.
- **A `next` key naming the destination state.** Rejected: the written
  labels plus the state matches already determine the destination, and the
  key would duplicate them.
- **A context-free verdict agent (the ranker) for the review outcome.** An
  agent with no context, no tools, and no environment answers a closed
  choice from the prompt. Parked: the only judgment in the shipped machine
  is the score, a number in a fixed format that lands in the completion
  trace; parsing it keeps the ship decision auditable and adds no LLM
  failure point. The mechanism gets designed when a real workflow needs a
  judgment no structured value can carry.
- **Additive migration.** Append the new config keys and leave the old
  templates untouched. Rejected in favor of the full rewrite: the seed
  templates' label prose is the exact material that caused issue #70, and
  the operator does not want to carry the precedent's misdesign weight.

## Consequences

- The plane writes to the external source, through one path: the
  transitions, through the command runner, at settle time.
  `docs/labels.md` is rewritten to state it.
- The label workflow runs in auto mode without pre-labeling: the default
  task type hands off the implement, the transition puts the pull request
  into the machine, and the auto-handoff picks up the review on the pull
  request's own ticket.
- The Decision modal states the label facts the transition wrote and offers
  close, goto, and the handoff of the new position's task. Auto-advance
  hands off without the operator even in manual mode, the mirror of the old
  auto-close.
- The score threshold is one number in one place: the review transition's
  judgment value. The docs cite it.
- The Same-type hold (ADR 0026) stands. Its left-behind-signal case (an
  agent that forgets to remove `ready-for-agent`) is now structurally
  impossible, because the plane removes the label itself, but the hold still
  guards the unlabeled-issue path where the default task type keeps
  suggesting `implement`.
- A pull request labeled by hand outside the plane enters the machine: the
  states match on labels, and the plane acts on any ticket the sources
  list, not only on pull requests it created.
- A human or a stale agent label write stands until the next transition
  converges. Between transitions, the source is the truth.
- The operator can now define their own workflow: their own labels, their
  own states, and parking states where a human or another tool drives the
  flow by writing labels.
- The migration rewrites a user-owned file once. The backup and the one-time
  report are the undo and the record.
- The configuration reference (`docs/configuration/index.md`) and the
  getting-started guide still document the current file format; they update
  when the implementation lands.
