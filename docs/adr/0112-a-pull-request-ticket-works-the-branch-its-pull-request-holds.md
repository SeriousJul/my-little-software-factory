# ADR 0112: A pull request ticket works the branch its pull request holds

Status: accepted
Date: 2026-10-06
Supersedes the "one ticket owns one branch" rule the naming module states for
factory branches. Extends ADR 0076 (the Pull request open) on the pull request
side of the cycle, and leaves ADR 0042 (the Fixing pull request) and every
issue-side read rule standing. Tracked as issue #322.

## Context

A worktree Handoff works the branch the naming rule gives its ticket:
`factory/<ticket id>-<title slug>`, keyed on the ticket's external key. Herdr
names the worktree checkout after the branch it was made for, so the workspace
wears the branch name.

One cycle crosses two tickets. The implementation works the issue, and the
pull request it opens - through the Pull request open (ADR 0076) - becomes the
ticket the review and the rework work. The issue's factory branch is
`factory/<issue>-<slug>`, and the pull request ticket's own name is
`factory/<pull request>-<slug>`. The pull request's head is the issue's factory
branch, and nothing names the numbered branch: it stands neither in the
checkout nor on origin when the review's start looks for it.

The measured shape of that split, in the development install: a cycle pair
wearing `factory-311-frame-waits...` for the issue and
`factory-318-frame-waits...` for the pull request, two workspaces for one
cycle. The review's start, finding its branch in no copy, builds it from the
Worktree base, the remote default branch. The review agent's checkout carries
no implementation. The rework has the same split: its push lands on a branch
that is not the pull request's head, so the change never reaches the pull
request unless the agent checks the pull request out on its own.

Two tickets of one cycle sharing one body of work, under two branch names, is
the fault. The names are read from two different tickets, and the work stands
on only one of them.

## Decision

**A worktree Handoff of a pull request ticket works the branch its pull
request holds: the head branch the source records on the pull request's
membership.** The rule stands where the Handoff states its branch. The
pull request's head is, in the cycle this decision exists for, the issue's
factory branch, so the review's start finds the worktree that holds that
branch - the workspace the implementation worked in - and reuses it, the way
the stored-workspace reuse already does. One branch, one worktree, one
workspace for the whole cycle, wearing the issue's number. The review agent
finds the implementation in its checkout, and the rework's push lands on the
pull request's head.

**The fallback is the ticket's own factory branch, and a start is never
refused for the fact.** When the head-branch fact is missing - an old row, or a
source answer that carried no head ref - or when the branch stands neither in
the checkout nor on origin, a pull request from a fork, the ticket works
`factory/<pull request>-<slug>`, the behavior it has today, and the review
stays reviewable through the source the way it is now. The fallback is taken
as a stated fact at the Handoff's branch statement, where the checkout is
known and the origin read the reuse path already makes can run, not as a
silent choice inside the environment builder.

**The issue side is untouched.** The issue's factory branch keeps its name,
the Pull request open keeps opening on it, the cycle-end draft close keeps
closing it, and the Fixing pull request rule keeps deriving the link: its
branch-prefix fallback reads the issue ticket's external key, and the shared
branch still carries it. No issue-side read rule learns the new rule.

**The "one ticket owns one branch" rule is superseded for the pair of one
cycle.** The naming module states that one ticket owns one branch and a second
ticket never shares the first's. That rule is true of two unrelated tickets,
and it stays true of them. The issue and the pull request of one cycle are not
two tickets with two bodies of work; they are one body of work under two
tickets, and they share the branch, the worktree, and the workspace. A
pull request ticket wears its own numbered branch only in the fallback case,
and a ticket outside a cycle the plane opened - a human-made pull request -
works whatever branch its pull request holds, and falls back the same way.

**A worktree the last agent left on another branch keeps its existing
recovery.** The reopen by the worktree's path, on the branch the agent left
it, is unchanged: the agent's own choice of branch still outruns this rule the
way it already does.

**In-flight cycles heal on their own.** A cycle that started before this
change, still wearing two names, takes the shared branch at the pull request
ticket's next start. No migration runs, no branch or worktree is renamed, and
no operator act is asked.

## Options considered

- **Name the work by the pull request number from the first implement.** The
  branch of a task type that opens a pull request would carry the pull request
  number, and the plane would rename it once the Pull request open answered
  with the number. Rejected: the branch name is fixed before the pull request
  number is known - the open needs the branch to stand on origin before it can
  open anything - so the rename stands in the middle of a start, over the local
  and the remote ref. Herdr names the worktree checkout after the branch, so
  the workspace follows the name only if the directory moves too, or the cycle
  keeps wearing the old name in the one place the operator sees it. And three
  issue-side read rules key on the issue-numbered branch name - the read of the
  ticket's own pull request, the cycle-end draft close, and the Fixing pull
  request's branch-prefix fallback - so the rename re-keys every one of them
  or the fire loses the pull request it just opened. The fallback naming the
  open's failure forces - no number yet, keep the issue number - reintroduces a
  second name for the same cycle. This option is the larger change, and it
  buys a number in the name, which the operator did not ask for.
- **Keep the split and teach the review and rework agents to check the pull
  request out themselves.** Rejected: the prompt already names the pull
  request's url, and a capable agent copes. The plane does not build an
  environment whose contents it then asks the agent to repair; the code under
  review is the plane's to put in the checkout.
- **Key the rule on the task type, not the ticket.** A per-task-type naming
  override for the review and the rework. Rejected: the split is between
  tickets, not between task types - it is the ticket's kind, issue or pull
  request, that today decides the branch. A rule keyed on the ticket's kind
  covers the review, the rework, and any task type that works a pull request
  later, in one statement.
- **Fall back to a refusal when the head branch cannot stand in the
  repository.** Rejected: the fallback branch keeps a fork pull request
  reviewable the way it is today, and a start refused for a fact the source
  never recorded spends the Handoff limit on a read that no refresh will
  answer.

## Consequences

The naming module's contract wording - one ticket owns one branch, a second
ticket never shares the first's - is rewritten for the pair, and the glossary's
Handoff entry states the rule beside the agent name's (issue #322 carries the
wording change with the implementation). ADR 0076's Pull request open is
unchanged on the code; its account of the cycle now reads with this decision:
the branch the open stands on is the branch the whole cycle works.

The environment builder learns nothing: the branch it opens the worktree on is
the branch the Handoff states, and the reuse policy is the policy it already
runs. The availability read the rule makes - the local branch check and the
origin read - are the reads the start's reuse path makes the same way, so the
rule adds a read only where it changes the answer.

Two tickets can name one branch now, and a rule that assumed one ticket per
branch has to say so when it reads the cycle's branch. The Fixing pull request
rule is checked against that assumption and stands: it reads the issue
ticket's key, and the shared branch carries it. The name of the cycle's
workspace is the issue's number for the whole cycle, and the operator asked
for one name, not a particular one.

The screen-reader path is not touched by this decision, and the inherited-theme
walks have not been re-run on it: the change states no new surface fact. The
suite's account of the rule stands in the naming and the handoff start tests
(issue #322 names the seams).
