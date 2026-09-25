# ADR 0062: The plane moves a leftover worktree directory aside, and never deletes it

Status: accepted
Date: 2026-09-25

## Context

A worktree Handoff asks herdr to create its checkout, and herdr names that
checkout after the branch: `factory/<ticket id>-<title slug>`, with its slashes
for hyphens, inside the repository's herdr worktree directory (ADR 0046 reads
the same rule). The name is therefore fixed: the same ticket always asks herdr
for the same path.

That fixed path can stand on disk while nothing owns it. Observed on ticket #37
of `seriousjul.github.io`:

```
~/.herdr/worktrees/seriousjul.github.io/factory-37-deps-.../          exists, 44K
  .docusaurus/**                                                     the only content
  .git                                                               absent
git worktree list --porcelain                                        no record of the path
.git/worktrees/                                                      no record of the path
git branch --list factory/37-...                                      the branch exists, checked out nowhere
```

A build cache an Agent wrote recreates the directory after its checkout is
removed, and the removal had already dropped git's record. Git will check a
branch out into an existing empty directory and refuse a non-empty one:

```
$ git worktree add ./empty2 probe/branch   ->  Preparing worktree (checking out 'probe/branch')
$ git worktree add ./nonempty probe/branch ->  fatal: './nonempty' already exists   (and -f does not lift it)
```

So the reuse sequence dead-ends. The branch exists, so the Handoff takes the
reuse path; herdr finds no worktree holding the branch; the path lookup finds
no worktree at the reserved name; the fresh create is refused by the directory.
Every retry answers the same way, forever, and the ticket's committed work
strands on its own branch.

Neither tool clears it. `herdr worktree remove` needs a workspace, and herdr
holds none. herdr's own remove recovery refuses this shape too: it checks the
leftover's `.git` file for a gitdir inside the repository, and the directory
has no `.git` at all. `git worktree prune` clears records whose directory is
gone; this is the opposite - a directory whose record is gone.

ADR 0012 settled the destructive answer for a neighbouring case: a leftover
environment is a fact the operator acts on, because "discarding someone's
uncommitted work is never the side effect of an unrelated action". This case
sits on the same rocks with different tools: the residue is not a herdr
environment, so the plane's own surfaces show nothing and herdr offers no
action, and the operator has to read a filesystem path out of git's refusal and
delete files by hand.

The alternatives:

- Delete the leftover directory, then create. Rejected for ADR 0012's reason:
  the plane cannot tell a build cache from an Agent's uncommitted, untracked
  work, and it must not guess.
- Report the fact and do nothing else. Rejected as the whole answer: the ticket
  stays unworkable until the operator notices a path in a truncated Message
  line, and the plane knows exactly which directory it needs.
- Ask herdr for the worktree at a different path. Rejected: the naming rule is
  how the plane and the operator find a ticket's checkout, and a second name
  for the same ticket breaks the reopen lookup that rule serves (ADR 0046).
- `git worktree prune` before a create. Rejected here, kept as a separate
  question: prune answers a stale record, not an unowned directory, and this
  residue is the latter.

## Decision

**The plane moves a leftover worktree directory aside, and never deletes one.**

One create refusal is recoverable, and the plane recovers it once: before it
asks herdr for the create again, it renames the reserved path out of the way to
`<path>.leftover`, or the next free numbered name beside it, and carries the
fact on the Handoff's notes, which reach the Message line whether or not the
start then lands.

Three proofs gate the rename, and each closes a door the plane must not walk
through:

- **The naming rule names the path.** The path comes from herdr's own
  `worktree list`, the same derivation ADR 0046 established. A list that does
  not read names no path, so no directory is touched.
- **git holds no record of the path.** A recorded worktree - standing or
  prunable - is herdr's and git's to open or remove. The plane moves nothing a
  tool still owns.
- **The directory holds no `.git` entry, and holds something.** A directory
  with a `.git` entry is a checkout, and the plane never moves a checkout. An
  empty directory blocks no create, so a refusal beside one is about something
  else, and moving it would be a side effect with no cause.

The move keeps every byte: the operator sees where the residue went in the
Handoff's line, and can inspect it or remove it. The plane deletes nothing,
anywhere, in this path.

## Consequences

- A ticket whose reserved path was resurrected by a build cache starts again on
  its own, with one warning line that names both paths. The permanent dead end
  is gone for the shape above.
- herdr's worktree root gains `.leftover` directories over time. That is the
  cost of choosing a move over a delete, and the plane says where each one
  landed rather than hiding it. The operator removes them, not the plane.
- A refusal the proofs do not explain comes back exactly as it was: git's own
  line, and herdr's stable code beside it. The plane adds no guess to a
  refusal it cannot name.
- A stale git record for a directory that is gone still blocks a create, and
  still needs `git worktree prune` or `git worktree remove` to clear. The plane
  reports that refusal and does not act on it; if it becomes common, prune is
  its own decision, at the same seam.
- The Handoff notes carry one more fact, and both report sites read it: the
  ticket Handoff's outcome line and the Consultation's own. The move line has no
  success gate, because a moved directory is a fact the operator needs even when
  the start fails after it.
- The reopen lookup and this rule read one derivation of herdr's naming rule,
  so the two can never disagree about where a ticket's worktree lives.
