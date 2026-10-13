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
Action bar.** A frame test names a Control catalogue id. The rig owns a
painted hint to the named control on three reads, and a hint the control does
not own is not its key: the hint's key label is one the catalogue paints for
the control in a mode the control runs, read through the catalogue's own
display-label function the Action bar paints with, with the Agent terminal's
exit key read from the plane's config; the hint's word starts with one of the
control's label wordings, its static label plus the rig's own wording table for
the controls whose `barLabel` repaints it; and the control runs on the
frame's surface, read off the frame's own markers, where a frame that names
no surface resolves permissively, so a reworded marker weakens the filter
and never misresolves a control the bar names. Exactly one owned hint sends
its first painted key, or a named `via` token if the press names one. No
owned hint fails, naming the control and the hints the bar paints, and stating
that the bar paints no hint the control owns. More than one owned hint fails
and names every match, key and label, so a pair that paints the same key
twice still names both. A hint the catalogue paints display-only - a label
for a control that claims no key, the text row's Type and Backspace - is
owned the same way and is keyless: the rig owns it to its control and fails
a press that names it, because the field the hint names owns its own keys.
The closed walk is the same rule turned around: each painted hint is owned
by the catalogue - exactly one control can paint it on the frame's surface -
and the walk asserts the catalogue owns the hint on exactly one control and
the rig resolves that owner to a key the hint painted. Its ground truth is
the painted frame and the catalogue's facts, and the ownership it checks is
the rig's own three reads applied per control, so the matcher is not its own
ground truth: a drift between the bar and the catalogue fails the walk. A
painted hint two catalogue controls can both paint stands in issue #387,
filed under the rule below: a finding about the bar, not a rig workaround.

The rule leans on the catalogue's standing guarantee that the bar never shows a
hint whose keys do something else in the current mode. That guarantee is what
makes a key read off the screen safe to send. A test can then only press a key
the plane advertises, which is the operator's path.

**Naming is by Control catalogue id, not by hint wording.** Naming by wording
was rejected: it re-couples the suite to a wording, and the quality gate already
refuses restating a wording that has its own test. The `refuses` outcome takes
the wording the test names, and the spec's story 7 - the outcome reading the
catalogue's own words off the Message line - stands: the catalogue's interface
does not expose the refusal words per control, so the test still names them.

**A frame test names one outcome from a closed set, and the rig owns the wait.**

- `opens` and `closes` - a surface appears or goes away, and its key ownership
  settles with it.
- `refuses` - the Message line carries the control's refusal, and the
  outcome takes the wording the test names: the catalogue's interface does
  not expose the refusal words per control, so the test still names them.
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

**The escape list is closed and named.** Four controls stand outside the Action
bar: the auto-handoff toggle, the quit and the emergency exit, and the
repository init. The field's twelve editing rows are guide-only: a field's
editing keys, which the plane dispatches nowhere. Those routes stay, as named
rig operations for typing and for the form's slot walk. A static check refuses
a frame test that reaches for a raw key outside the list, in the shape of the
assertion-architecture check and the shared-control check.

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

## Addendum: the rework of the delivered rule

The rule as first delivered matched the painted hints on the key label alone.
On the base frame that owned the bar's painted Decide hint to every catalogue
control that answers to Enter, and a press that named one of them resolved to
the hint the plane painted for another. The rework adds the two reads the key
label cannot carry: the hint's word, matched against the control's label
wordings, and the frame's surface, matched against the control's modes. The
surface read runs on the markers the frame itself paints, and a frame that
names no surface resolves permissively, so the read degrades to the weaker
filter instead of misresolving. The closed walk moved with the rule: it owns
each painted hint to the catalogue, exactly one owner, and asserts the rig's
resolution of that owner against the hint, so it can no longer assert the
matcher against itself.

## Addendum: the surface read names the modes, and the press guards the shared hint

The rework above left the rule one step short of the frames it runs on: the
surface read answered a surface family, and a painted hint two catalogue
controls can both paint stood in issue #387 with no rule of its own. The walk
asserted exactly one owner per hint, and a press of a hint two owners shared
sent the painted key to the owner the catalogue ranked first, the other
owner's hint standing unread behind it.

Both statements are superseded. The surface read names the catalogue modes
the frame stands on, read off the frame's own markers: the full-screen
surfaces' titles, the modal and panel titles' stable prefixes, the section
boxes' focus markers, and the detail panes' focus markers, the consultation
and the Work queue detail modes split on the bar's own section labels. A
frame that shows no marker still resolves permissively, the way the family
read did. The closed walk records the owners of each painted hint, one or
more, and asserts the catalogue owns the hint and the rig resolves every
owner to a key the hint painted. A hint two owners share does not fail the
walk: on a surface the rig names the read separates the owners, and on a
surface it names not the bar's disagreement is the finding the rig records
and the press guard files, not a failure of either owner.

The press gained the rule the walk left open: a painted hint two catalogue
controls can both paint is not a key the rig can own. A press of it - a press
named with `via` included, because the guard reads the hint the press would
send, not the wording that chose it - throws the rig's named error and the
co-owners it files. A suite that meets the collision stands the frame on a
surface the rig names, or it walks the bar and records the hint's owners.

Issue #387 closes with the pull that lands this rule. On the Seeded plane no
frame stands a painted hint two catalogue controls can both paint: every
frame stands a surface the rig names, or stands a permissive surface whose
painted hints each resolve to one owner, and the measurement stands frame by
frame in the verification record. The guard's throw is pinned in the rig's
own suite on the one collision the surface read cannot name: a frame with no
marker, and a bar the permissive read leaves to two owners.
