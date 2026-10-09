# ADR 0128: The frame rig runs controls, not keys

Status: accepted
Date: 2026-10-09

Records that the frame rig resolves every key it sends from the Control
catalogue, through what the Action bar states on the current frame, and that a
frame test names a control and one outcome from a closed set instead of a key
and a frame predicate. It moves no control, changes no key, rewords no hint, and
touches no surface.

## Context

The plane owns one Control catalogue: 71 controls, each with its keys, its
Interaction modes, its availability, and its reason when it is unavailable. Two
projections of it stand on the screen every frame. The Action bar packs its
hints from the catalogue and paints each one as its key label and its hint
label, and the catalogue refuses to show a hint whose keys do something else in
the current mode. The shared control dispatch reports a refused control in the
catalogue's own words, and the Main view wires that report to the Message line.

The frame rig uses none of it. It sends a character the test picked and waits on
a predicate over the painted frame. Measured at head `3f5c7662`: 875 frame waits
in the suite, 591 of them an inline containment predicate, 1,888 distinct
hand-written wait descriptions, 986 press-family sites, 593 stability waits, 188
open-and-close helper sites, and 193 waits on the rig's key-ownership apparatus.
The hand-picked literals run `j` 196, `return` 68, `f` 29, `r` 28, `i` 25,
`delete` 24, `x` 18, `k` 18, `home` 17, `?` 14, `l` 13, `u` 12, `escape` 12,
`end` 12, `e` 12, `a` 12, and further.

Three costs follow, and each is already on the record.

**A control that keeps its meaning but changes its key sweeps the suite.**
Issue [#353](https://github.com/SeriousJul/my-little-software-factory/issues/353)
replaced `w Close` with the Delete key, one control whose behaviour did not
change, and touched 13 test files at +738/-180 test lines. ADR 0122 decided that
key; the suite paid for it in characters.

**The wait stands on wall-clock time.** The rig's deadline is 10,000 ms locally
and 20,000 ms on a CI runner, because the local number was not enough there.
Twelve issues stand in this one class: #302, #303, #304, #310, #311, #312, #314,
#316, #318, #323, #326, and #342. The quality gate page states that the gate does
not fix the CI frame-test flake and that the item stays open. The same page
states that a test does not stand on wall-clock time. The two rules are in
tension, and the deadline doubling resolved it in favour of the first.

**The rig compensates for its own interface.** It carries three waits on the
renderer's key bus, a bus watcher that snapshots and observes subscriptions, and
188 open-and-close helper sites that each run one frame wait plus one key-handler
wait. That apparatus exists only because the rig sends a key before it knows
which surface owns keys. It is not a property of the plane.

The rig is shallow: 1,462 lines and 77 exports, and its caller supplies a key, a
predicate over a raw frame string, and a description of what it expects. What a
key means, and what the plane owes after that key, sits in each of the 42 frame
suites instead of in the rig.

## Decision

**The rig resolves every key it sends from the Control catalogue, through the
Action bar.** A frame test names a Control catalogue id. The rig takes that
control's key aliases as their display names, reads the Action bar row of the
current frame as its spans, and matches the painted hints whose key part is one
of those aliases. Exactly one match sends that key. No match fails, naming the
control and stating that the Action bar shows no hint for it in this frame. More
than one fails and names every match.

The rule leans on the catalogue's standing guarantee that the bar never shows a
hint whose keys do something else in the current mode. That guarantee is what
makes a key read off the screen safe to send. A test can then only press a key
the plane advertises, which is the operator's path.

**Naming is by Control catalogue id, not by hint wording.** Naming by wording
was rejected: it re-couples the suite to a wording, and the quality gate already
refuses restating a wording that has its own test. The refusal wording a test
checks comes from the catalogue, not from a copy in the test.

**A frame test names one outcome from a closed set, and the rig owns the wait.**

- `opens` and `closes` - a surface appears or goes away, and its key ownership
  settles with it.
- `refuses` - the Message line carries the catalogue's own refusal words for
  that control.
- `shows` and `hides` - the screen text, for the facts that are not a control's
  effect.
- `moved` - which pane or section holds the cursor.
- `quiet` - the stability wait, kept only where stability is the assertion.

The rig owns the frame poll, the passive-effect flush, the key-ownership window,
and the deadline.

**The key-ownership apparatus becomes internal.** The bus snapshot, the bus
watcher, and the three bus waits leave the rig's interface. A caller no longer
takes a snapshot, because a caller no longer knows there is a bus.

**One deadline stands, with no per-test budget and no CI branch.** The migration
records the measured wait times at the head it measured them on, so the number is
evidence.

**The escape list is closed and named.** Five controls stand outside the Action
bar, and three more are guide-only: a field's editing keys, which the plane
dispatches nowhere. Those routes stay, as named rig operations for typing and for
the form's slot walk. A static check refuses a frame test that reaches for a raw
key outside the list, in the shape of the assertion-architecture check and the
shared-control check.

**No production code changes.** No control moves, no key moves, no hint rewords,
and no surface is touched. Where the rule cannot resolve a control through the
bar, that is a finding about the bar: it gets filed, not worked around.

## Considered options

- **Name the control by the hint wording the bar paints.** Rejected: it re-couples
  the suite to a wording the Key guide and the Action bar already own.
- **Hand the rig the live availability facts.** Rejected: it opens a new, lower
  seam. A test could then resolve a key the operator never sees advertised, and
  the Action bar stops being the fact the test reads.
- **Keep the key literals and add an alias table the tests read.** Rejected: it
  puts a second map of key meaning beside the catalogue's, which is the thing the
  catalogue exists to prevent.
- **Widen the deadline again.** Rejected: that is the wall-clock stand-in the
  quality gate already refuses, and it leaves the 1,888 wait descriptions and the
  re-key sweep standing.
- **Deepen the rig's screen probes as well.** Rejected as out of scope: those
  probes are already deep, and a test that asserts a painted fact should keep
  them. This decision covers the input side and the wait side.

## Consequences

A key change lands in the Control catalogue and nowhere else. The suite follows
at its next run, because it names the control and not the key.

A frame test reads as the operator's walk: one control and one outcome. A
reviewer can check it against the Action bar and the Key guide without decoding a
screen substring.

The rig's interface shrinks and its implementation absorbs the waits, the flush,
the key bus, and the deadline. The 42 frame suites lose their preamble.

The flake class gets one home, which is what makes it fixable. Whether it closes
the CI item is a measurement and not a claim: the migration records the counts
before and after, the full-suite runs with the machine state, and each file that
fails in the full suite and passes alone named as a load flake. What it does not
reach stays open and stays named.

The migration is per surface, and it lands after the test-duplication count
stands, so the Quality baseline shows the fall and holds it. Issue
[#360](https://github.com/SeriousJul/my-little-software-factory/issues/360) gives
the Quality audit the count, issue
[#363](https://github.com/SeriousJul/my-little-software-factory/issues/363) is the
campaign that shrinks it, and issue
[#365](https://github.com/SeriousJul/my-little-software-factory/issues/365) is the
spec for this change.

The glossary names the **Frame rig**. As with ADR 0122, the decision and the term
land before the key change they govern does.
