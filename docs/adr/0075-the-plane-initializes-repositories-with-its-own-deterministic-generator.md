# ADR 0075: The plane initializes repositories with its own deterministic generator

Status: accepted
Date: 2026-10-01

## Context

A repository enters the factory when a ticket source lists it. Before the
machine can run in the repository, the operator makes two manual passes: the
labels the machine writes must exist in the repository (the label page
documents `gh label create` for each one), and the agent-side setup skill
(`setup-matt-pocock-skills`) is run inside the repository, where it interviews
the operator per repository and writes `docs/agents/issue-tracker.md`,
`docs/agents/triage-labels.md`, `docs/agents/domain.md`, and the `## Agent
skills` block of the repository's `AGENTS.md` or `CLAUDE.md`.

Both passes re-answer questions whose answers are factory-wide. The tracker,
the triage vocabulary, and the domain doc layout are the same for every
repository of one factory, and the label set the first pass creates is already
declared by the workflow machine in the config: the states' matches and the
transitions' facts. The setup skill's per-repository interview and the manual
label pass duplicate what the factory's own settings already decide.

The plane already holds the exits the act needs. Its Command runner runs `gh`
with the sources' own authentication, and the plane already writes back its
own config when a resolution bends to a sibling clone.

## Decision

**The plane owns the Repository init.** One operator-confirmed act makes one
repository factory-ready: it creates the missing labels, writes the
convention files and the Agent skills block, and registers the repository's
sources.

**The generator is deterministic, and no agent runs.** Every byte of the act
is a function of the factory's settings. The label set is derived: the union
of every label a transition writes (the `ticket-facts` and `pull-request-facts`
of every task type and branch) plus the five canonical triage labels. The
convention files and the block come from templates the plane owns in its own
repository, tested by its suite. The agent-side setup skill stays the path for
repositories outside the factory, and the `consult` Consultation type stays
the escape hatch for a genuinely irregular repository.

**The settings are factory-wide, with no per-repo override.** The generator
owns the constants the act needs: the GitHub tracker, the canonical triage
strings, the single-context domain layout. A config section is born only when
a second value becomes real. A repository that needs something different gets
its files edited by hand; the plane treats the hand edit as differing content,
not as a setting.

**The act pushes to the remote default branch through a throwaway
worktree.** It fetches the remote default branch, opens a throwaway worktree
on it, writes, commits, pushes, and removes the worktree. It never gates on,
moves, or dirties the operator's checkout. The push is what makes the files
reach the agents: a worktree handoff bases its branch on a fresh fetch of the
remote default branch (the Worktree base), so an uncommitted or local-only
write reaches no agent.

**The act registers the repository's sources in the Config file.** One
`github-issues` and one `github-pull-requests` source, named
`<repository>-issues` and `<repository>-pull-requests`, each refreshing every
60 seconds: the issues source carries the `ready-for-agent` rank, and the
pull request source carries the machine's pull request positions and its
parking state. The `repos` mapping is written only when the resolution bent to
a sibling clone, the plane's existing rule. A source name already taken by the
operator's own source, or a refused label write, fails the act with the
reason. The act reuses the authentication of an existing source on the same
host, else the ambient `gh` authentication.

**The label set is the union, and only the union.** `blocked` is excluded: a
source-side filter label the plane never writes, and a filter on a missing
label matches nothing. The scoping labels are excluded: a state match may gate
on a label no transition writes, and those gates are the operator's own
decision to create. The colors and descriptions for `gh label create` come
from a fixed palette in the generator, one known pair per canonical label.

**The plane's footprint is file-owned.** A re-init overwrites the convention
files, and the Agent skills block is block-only surgery: from its heading to
the next level-two heading or end of file, never the surrounding sections.
`CLAUDE.md` wins over `AGENTS.md` when both exist, the setup skill's own rule,
and when neither exists the panel offers the choice of which to create.

**The act is the operator's, and the plane only signals.** The key is `i` on
a Group header of the Ticket section while the Grouping axis is `repository`;
the key refuses on any other axis, and the ticket-row meanings never clash
because a Group header holds no Ticket. The Repository init panel states the
plan before any external change: the labels to create beside the ones already
present, the files to write beside the unchanged and the differing files that
will be overwritten, and the target branch. A repository that is not
initialized, or that stands in Init drift, carries a marker on its Group
header, and the plane states a one-time note on the Message line at the first
sight of one. No Repository init runs by itself: the plane never pushes into a
repository it has only just seen.

**The state file holds one init fact per Initialized repository:** the hash
of the inputs that determine the generated content (the workflow states and
transitions plus the generator's version), the pushed commit, and the time. A
change of the inputs stands every Initialized repository in Init drift at
once, with no read of the repositories. A hand edit inside a repository stays
invisible until the operator re-runs the act, where the panel lists the
differing files before the confirm.

## Consequences

- Adding a repository to the factory is one confirmed act instead of a manual
  label pass plus a per-repository agent interview. The manual label step the
  label page documents becomes "run init", and the setup skill leaves the
  factory's own repositories.
- The plane becomes a writer into the repositories it otherwise only reads and
  clones. Its one repository mutation commits to and pushes the remote default
  branch, and it stands behind the operator's confirm in the panel.
- The convention files are plane-owned: a hand edit is legal and stands, but a
  re-init overwrites it, and the panel names every differing file first. The
  `## Agent skills` block keeps the operator's edits to the rest of the file.
- A state that gates on a scoping label the repository lacks parks its tickets
  until the operator creates the label. The init deliberately does not create
  it, and the label page keeps saying it is the operator's.
- The drift guarantee is settings-side only: a change of the settings stands
  every Initialized repository in drift, but a hand edit is caught only when
  the operator re-runs the act. The repo-side check that reads the repositories
  on every refresh is deferred, beside the "sync all" panel, a second tracker
  value with its config section, the security feeds in the init, and the
  auto-init that the act's signal replaces.
