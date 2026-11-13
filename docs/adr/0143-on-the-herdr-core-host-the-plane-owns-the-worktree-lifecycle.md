# ADR 0143: On the herdr-core host the plane owns the worktree lifecycle

Status: accepted
Date: 2026-11-12

Records that a Worktree Environment on the herdr-core host is a git worktree the
plane creates and removes itself, in herdr's own worktrees directory and by
herdr's own naming rule, so one Ticket keeps one checkout across a host switch,
and that the reopen lookup reads git's record rather than one host's list. It
changes no worktree rule the operator reads, decides no gate, and lands no code
([ADR 0141](./0141-the-plane-resolves-its-agent-host-herdr-or-herdr-core.md),
[ADR 0142](./0142-one-run-holds-agents-on-both-hosts-and-the-host-stands-on-the-handoff.md)).

## Context

On the herdr host the worktree is herdr's. The plane asks for `worktree create`,
reads `worktree list --cwd`, and removes it with `worktree remove --workspace`,
which takes herdr's workspace down with the checkout. The rules built on that
are the plane's own and are load-bearing: the reopen by branch, the reopen by
path when git no longer records the worktree
(`findTicketWorktreePath`, which takes the parent of the repository's linked
worktrees and the branch's name), the Leftover worktree directory the plane moves
aside instead of deleting (ADR 0062), the residue record that removes only what
one start created (issue #204), and the merge ask's Close that takes the checkout
down with its workspace and keeps the branch (ADR 0124).

herdr-core answers no worktree command at all: its unit is a terminal with a
name, a cwd, and labels
([ADR 0141](./0141-the-plane-resolves-its-agent-host-herdr-or-herdr-core.md)).
Two measured facts say the host is not the only keeper of the truth. On
2026-11-12, against this repository:

- herdr's layout is `<home>/.herdr/worktrees/<repo name>/<branch with each slash
  for a hyphen>`. Every worktree the plane has is there, named from its branch
  (`factory-consultation-ba35ab04-grill-with-docs` for
  `factory/consultation-ba35ab04-grill-with-docs`).
- `git worktree list` on the source checkout already holds every worktree herdr
  created, at those same paths and on those same branches, and herdr's own
  `worktree list` answer is git's shape (branch, path, `is_linked_worktree`,
  `is_prunable`) with herdr's workspace facts beside it.

So a worktree the plane makes with git is findable by the same reads that find
herdr's, and the plane already runs git for the Worktree base's default-branch
rule (ADR 0075).

## Decision

**The Environment kinds stand on both hosts.** The launcher and the override
panel offer live checkout and worktree whichever host the start takes, and a
host never answers one of the plane's two Environments with a refusal.

**On the herdr-core host the plane runs git directly** for the worktree a start
creates, the branch it creates with it, and the removal its residue record and
the operator's Close ask for. The plane still never starts the Agent process
itself (ADR 0002): it makes the checkout, then asks herdr-core to run the Agent
in it.

**The path and the name follow herdr's rule.** The checkout stands under
`<home>/.herdr/worktrees/<repo name>/`, named from the branch with each slash for
a hyphen, so a Ticket whose first Handoff ran on herdr and whose next runs on
herdr-core reopens the same checkout on the same branch instead of forking a
second working copy of its own work. The plane owns no second worktrees directory.

**The reopen lookup reads git, and one lookup serves both hosts.** The branch
lookup and the leftover-path lookup of `readWorktreePaths` answer from git's
own record of the checkout's linked worktrees, because git holds both hosts'
worktrees, and herdr's extra fact (`open_workspace_id`) is read only where a
herdr workspace has to be taken down with the checkout.

**Each host's cleanup stays on its own side of the boundary.** On herdr,
`worktree remove --workspace` and the workspace and tab closes stand as they are.
On herdr-core, the residue record removes the terminal with `hc kill` and `hc rm`
and the checkout with git, and Close takes the checkout down with its terminal.
The plane runs no `git worktree remove` against a checkout a herdr workspace
still holds: that cleanup is herdr's to run, because only herdr's `worktree
remove` clears herdr's row, and an unconfirmed close leaves its resource standing
in the record exactly as it does today.

**The Leftover worktree directory rule is the plane's on both hosts.** The move
aside under a name that says what it is, and the never-delete rule (ADR 0062),
run wherever the blocking directory stands, since the directory is a fact of the
branch's name and not of a host.

## Considered options

- **Refuse the worktree Environment on herdr-core.** Rejected, and it was the
  first candidate: a half host that runs only one of the plane's two Environments
  forks every branch of the Handoff's environment builder on a host test, which
  is the shape that turns into permanent special cases.
- **Give the herdr-core host its own plane-owned worktrees directory.**
  Rejected: a Ticket that changes host mid-cycle gets a second checkout with a
  second copy of its own branch state, and the reopen-by-path rule then has two
  directories to guess between.
- **Let the Agent create its own worktree.** Rejected: the branch, the base, the
  placement write, and the residue record are the plane's facts before the Agent
  starts, and a start that cannot state its own checkout cannot roll back what it
  made.
- **Keep reading herdr's `worktree list` for the reopen lookup even on the
  herdr-core host.** Rejected: it puts a herdr dependency on a run whose host may
  be herdr-core alone, and it answers nothing about a checkout the plane made
  itself while git already answers about both.

## Consequences

- The plane owns the worktree path naming rule on both hosts, and that rule is a
  contract with herdr's directory layout. A herdr that changes where or how it
  names its worktrees is a measured break the plane's own lookup has to follow;
  the layout above is recorded against herdr 0.9.5.
- The Worktree Environment's residue kinds stop naming host objects one for one:
  on herdr-core a start's residue is one terminal and one checkout, and the
  record's confirmation rows read that way rather than pretending to a tab and a
  workspace.
- A host switch inside one Ticket cycle keeps one checkout, one branch, and one
  pull request, which is the point of taking herdr's path rule.
- git becomes an actor in the Handoff's environment builder on one host, so the
  git refusal shapes that ADR 0132's world already answers (a path that cannot be
  checked out, a stale record, a prunable worktree) are in the Handoff's path on
  that host and are answered there, not only in the Worktree base.
- The verification record states which worktree flows ran on herdr-core and which
  did not; no claim of parity is extended past the flows that ran, and the
  screen-reader path stays unverified as before.
