# 0160: The plane's boot call stands the Stub herdr world by default

## Problem Statement

The operator reads the plane through the frame suite's verdict, and the
verdict stands on the commands the test runner answers. On this tree the
test plane's default runner is a pin table: a flat map of exact command to
exact answer, built by the plane's boot call, seeded with the plane's own
git answers and its empty rosters, and extended per case by the suites that
stand on it. The table's answer is one row per pin, and it holds no state
a later read can agree with.

ADR 0132 cut the Stub herdr world beside the table: one deep adapter on
the Command runner seam that stands the herdr side, the git side, and the
herdr-core side from a stateful standing, and that refuses every shape it
does not model. The world stands four suites on this tree, and the world's
own suite pins its closed surface. The remaining frame suites stand on the
table: re-counted on this tree, the 34 frame suites pin 162 herdr vectors,
45 git vectors, and 20 GitHub-side vectors, and they boot the plane 411
times. The table's herdr and git pins are copies of what the world already
answers: every shape the frame suites pin stands on the world's surface,
and the extension the migration asked for stands at zero rows. Two
runners stand on the same seam, and the agreement between what the table
answers and what the world answers is kept by hand, per suite, per pin.

## Solution

The plane's boot call stands the Stub herdr world by default. Where the
Seeded plane's boot builds the pin table today, it builds the world on the
test's command runner and the plane's home and checkout paths, and it
stands the world beside the pin table in one egress: the world holds the
herdr side, the git side, and the herdr-core side, and the table holds the
residual, the GitHub side and the desktop notifications. The world's
standing starts empty, and a case that wants a richer standing names its
world standing on the plane's runner, the way the four suites do today.
The frame suites migrate one flow at a time, in ADR 0132's rule: a
migrated suite's herdr and git pins stand as the world's standing, and its
GitHub-side pins and its notification commands stay on the table. The
named world spec keeps its shape, and the frame rig's boot call keeps its
shape: a test that names no runner reads the world, and the warm pool
reseeds the runner and the world per test, the way ADR 0157's reseed list
already names them.

## User Stories

1. As the operator, I want the frame suites to read the same answers the
   plane's production run reads, so that a green frame suite is a frame I
   can trust.
2. As the operator, I want a shape the plane starts to build that the
   world never answered to fail the suite, so that I never learn of it on
   my machine as a code zero the table owed.
3. As the operator, I want the suites that stand the world and the suites
   that stand the table to paint the same frames for the same flow, so
   that the migration changes no frame I read.
4. As the machine, I want the test plane's egress to answer the herdr
   side, the git side, and the herdr-core side from one standing, so that
   a create I send shows up on the next list.
5. As the machine, I want a later read to agree with the command that
   came before it, so that the state I move is the state the test reads.
6. As the machine, I want the world's standing to start empty and grow
   only from the commands I answer, so that a suite that names no standing
   reads the empty world the table's empty pins stood today.
7. As the machine, I want the world to refuse the shape it does not
   model, so that the test fails where the real command would fail, not
   where a pin forgot me.
8. As the machine, I want the GitHub side and the desktop notifications to
   answer from the table beside the world, so that I hold the hosts I
   model and none I do not.
9. As the machine, I want one command log for the world's answers and the
   table's answers, so that the record the test reads of my external work
   is one record.
10. As the machine, I want a wait on an Agent the world holds to settle
    only when the world moves the Agent to a settle state, so that the
    wait I build blocks the way the real command blocks.
11. As the machine, I want the boot to build me in the same place it built
    the table, so that my construction costs no file and no process and
    the boot price stands.
12. As the machine, I want the plane's git answers to stand as my own
    answers from the checkout I hold, so that the boot pins no more of my
    side on the table.
13. As the test suite, I want the plane's boot call to stand the world
    where I name no runner, so that I read the default I stand without
    naming it.
14. As the test suite, I want the named world spec to keep its shape, so
    that I stand my own world on the plane's runner exactly as the four
    suites do today.
15. As the test suite, I want a world standing I name to refine the
    default, so that my Agents, my terminals, and my workspaces stand
    beside the world's empty standing.
16. As the test suite, I want my herdr and git pins to stand as the
    world's standing in the migration, so that I move my knowledge once
    and not per pin.
17. As the test suite, I want my GitHub-side pins and my notification
    commands to stay on the table, so that the migration leaves them
    standing where the world does not hold them.
18. As the test suite, I want to read the world's state at the end of a
    flow, so that I pin the result of my external work instead of the
    command that sent it.
19. As the test suite, I want the frame rig's warm pool to reseed the
    runner and the world per test, so that my flows start clean and my
    boot price stands.
20. As the test suite, I want the four suites that name the world to keep
    their named spec, so that the migration reaches the other thirty-three
    and stops.
21. As the test suite, I want my boot to stand on the world through the
    frame rig's boot call, so that my App reads the world and my frames
    stand.
22. As the test author, I want to stand a world standing instead of
    pinning a table, so that I write the state once and the commands
    answer from it.
23. As the test author, I want the world's closed-surface walk to fail me
    where my new command shape is unmodelled, so that I extend the world
    at the walk, not at a failing frame.
24. As the test author, I want the world's own suite to grow the
    command-behavior pins, one per command, so that the oracle travels
    with the coverage.
25. As the test author, I want the table's builders I stop needing to fall
    away with the pins they built, so that the shallow side I leave behind
    does not stand beside the deep side I keep.
26. As the test author, I want to migrate one flow at a time, so that each
    flow I move stands on the world before I move the next.
27. As the test author, I want a suite that pins the table's answers
    against a directory the world holds to name the table on its runner,
    so that the named spec stands over the default where I choose it.
28. As the test author, I want the world's held wait to refuse a target
    the world does not hold, so that my test that names no Agent for a
    wait fails at the standing, not at the frame.
29. As the test author, I want to name my standing with the world's own
    vocabulary, workspace, tab, pane, Agent, and terminal, so that my
    standing reads as the world reads it.
30. As the operator, I want the migration to be replace-not-layer, so that
    a pin that stands moves to the standing and no pin stands beside it.
31. As the machine, I want the table's code-zero empty to stand only on
    the residual, so that my refusals carry the weight the table's
    silence dropped.
32. As the test suite, I want the suites that stand an empty standing to
    read the default without naming it, so that the named spec is a
    refinement I use, not a default I rebuild.

## Implementation Decisions

- **The default the boot call stands.** The Seeded plane's boot, where the
  case names no runner, builds the world on the test's command runner and
  the plane's home and checkout paths. The world's standing holds a
  checkout for every repository the plane's config maps to a directory the
  plane stands, with the repository's clone URL and the worktree root
  beside the checkout, and it holds no checkout where the config maps
  none. The standing starts empty of workspace, tab, pane, Agent, and
  terminal, and the plane's own seeding, the empty Agent list and the
  empty herdr-core roster, stands as the world's empty standing: the boot
  read settles the same way on the world as on the table.
- **The composition of the default egress.** One egress stands the world
  and the table. The herdr side, the git side, and the herdr-core side
  route to the world, and every other command, the GitHub side and the
  desktop notifications, falls through to the table, which keeps its
  code-zero empty for the commands the plane builds there. The egress
  routes the model list query to the world, and it keeps one command log
  for both sides, so the egress's record of the external work is one
  record.
- **The plane's git answers at the world's seam.** The git-dir fact and
  the origin URL fact the boot pins on the table for the plane's healthy
  checkout stand as the world's own git answers from the checkout it
  holds, and the world's missing-checkout answers stand where the plane
  stands a directory with no checkout. The boot pins no more of the
  herdr side or the git side on the table, so the plane's git pins stand
  at the world's own seam, not only through the plane's boot call.
- **The named world spec keeps its shape.** A case that stands its own
  world, or wraps the runner, names it on the plane's standing exactly as
  the four suites do today, and the named refinement stands over the
  default. A case that wants the table's answers against a directory the
  world holds names the table on its runner, and the named spec stands
  over the default where the case chooses it.
- **The world's refusal over the table's silence.** A shape the plane
  builds that the world does not hold is a refusal that fails the test.
  The table's code-zero empty stands only on the residual, where the
  GitHub side and the desktop notifications answer as they do today.
- **The world's held wait over the table's blind hold.** A settle state
  the world holds answers at once, a target the world does not hold is a
  refusal, and every other target holds, the way the real command blocks,
  until the world moves the Agent to a settle state.
- **The migration, one flow at a time.** A migrated frame suite's herdr
  and git pins stand as the world's standing the suite names on the
  plane's standing, and the suite reads the world's state at the end of
  its flows. The suite's GitHub-side pins and its notification commands
  stay on the table. The table's builders a suite stops needing fall away
  with the pins they built, and the shallow side the campaign leaves
  behind shrinks suite by suite.

## Testing Decisions

The frame suites read the plane through the frames the frame rig paints,
and the rig keeps the plane standing on the runner the boot call stands.
A good test pins external behavior at the seam: the command record the
egress keeps is the evidence of the plane's external work, and the frame
the rig paints is the evidence of what the plane read of it. The seams
this record pins are the Command runner seam the world stands on, the
Seeded plane's runner, the frame rig's boot call, and the world's own
closed surface.

- **The world's own suite stands the world at its own seam.** Its
  command-behavior pins grow with the coverage, one per command, so the
  oracle travels with the coverage. The closed-surface block walks the
  real command shapes the plane builds, the herdr side, the git side, and
  the herdr-core side, against a healthy world, and it refuses any
  refusal, so a shape the plane starts to build that the world never
  answered fails the walk before it fails a frame.
- **The four suites that name the world stand the prior art.** The
  auto-mode frame suite drives the plane through the frame rig, and the
  consultation operations suite, the handoff dispatch suite, and the agent
  input suite drive the plane without the rig. They stand their worlds on
  their own command runners and their own paths, and they hand the egress
  to the plane's boot call as the named runner. Their shape is the shape
  the frame suites take when they migrate, and the default this decision
  stands takes that shape where a suite stands an empty standing.
- **The frame suites pin the frames the plane paints.** A suite that
  paints the same frames on the world as on the pin table is a passing
  migration step: the suite's herdr and git pins stand as the world's
  standing, the suite's GitHub-side pins and its notification commands
  stand on the table beside the world, and the frames the rig paints
  stand untouched.
- **The git pins stand at the world's seam.** The git pins the plane set
  on the table today stand as the world's git command pins, at the
  world's own seam, so the world's git answers are pinned where the world
  stands them, not only through the plane's boot call.
- **The command record is the evidence of the external work.** The egress
  keeps one command log for the world's answers and the table's answers,
  and a suite that reads its egress reads the external work of both sides
  in one record. A suite that pins a command on the table reads the pin
  back through the log, and a suite that stands a world reads the
  standing back through the state.
- **The held wait is pinned at the world's seam.** A suite that stands an
  Agent and moves it to a settle state reads the settle state from the
  wait, and a suite that names no Agent for a wait reads the refusal. The
  prior art is the world's own suite, which pins both.

## Out of Scope

- The production host resolution stands: herdr and herdr-core are the
  plane's hosts in production, and the production entry builds the real
  command runner. This decision stands on the test plane alone.
- The ticket sources' doubles stand beside the runner, per ADR 0157's
  reseed list, and the GitHub side's own stand-in stands beside the
  ticket source seam.
- The runner's process mechanics stand: the timeout, the budget, and the
  spin watch of ADR 0138 ride on the test's command runner as before.
- The frame rig's waits are ADR 0156's record, and the boot price is ADR
  0157's record. This decision changes neither: the waits stand on the
  renderer's frame passes, and the world is in memory, built in the same
  place the table was built.
- The world's command surface stands as ADR 0132 cut it. The extension
  this migration asked for stands at zero rows, and the record says so.

## Further Notes

- **Order-safety with ADR 0157.** The pool's reseed list names the command
  runner with its fresh command log and the Stub herdr world that stands
  on it, on the per-test plane's runner, beside the fake command runner of
  the default path. This decision stands a different object in that slot:
  the default path's runner is the world composed with the table, and the
  list stands as written. The pool reseeds whatever runner the boot call
  stands, and the warm facts never touch the plane's facts, so the
  decision is order-safe in either direction. ADR 0156's waits stand on
  the renderer, not on the runner, and they read the frame the plane
  paints on whatever runner it stands.
- **The residual, named.** The residual outside the world's hosts is two
  families: the GitHub side, and the desktop notifications. They stand on
  the pin table, the plane's own fake command runner, beside the world in
  the default egress. A new host the plane starts to build stands on the
  residual until the world models it, and the closed-surface walk keeps
  the world's surface closed against the herdr, git, and herdr-core
  commands it models.
- **The migration's reach.** The world stands four suites today, the
  auto-mode frame suite and the three suites that drive the plane without
  the rig, and one of the 34 frame suites stands the world. The remaining
  33 frame suites stand on the pin table, 411 boot calls across the 34
  frame suites, the largest suites 57, 46, 36, and 32 boots. The frame
  suites' herdr and git pins are 162 and 45 vectors, and the table's
  builders the campaign leaves behind fall away suite by suite.
- **The census at the world's seam.** Re-counted on this tree, the suites
  pin 346 herdr vectors, 160 git vectors, 80 GitHub-side vectors, and 18
  herdr-core vectors across the suite, and every herdr and git shape the
  frame suites pin stands on the world's surface. The extension stands at
  zero rows, and the work the migration does is the move of standing, not
  the growth of the world's table.
