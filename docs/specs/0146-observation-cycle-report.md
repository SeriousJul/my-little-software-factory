## Problem Statement

The operator watches the base screen while the Agents work. The Agents sit
in a turn for minutes, and the plane's observation cycle probes the Agent
host once every five seconds - twelve times a minute. Nothing moves, but the
screen visibly re-renders and rewrites twelve times a minute. The operator
cannot tell a screen that learned something from a screen that merely ticked:
the steady state of the plane looks like churn, and the redraw that would
signal a real change is buried in the redraws that signal nothing.

The churn is the seam's shape. The observation cycle hands the plane two raw
facts per cycle: a change signal, and the probe's roster, which its
documented contract says fires on every cycle so that a failed probe can show
its failure marker without any state change. The plane stores the fresh
roster in its screen state on every cycle, re-renders, and repaints the
terminal whether the roster moved or not. The coordinator module already
compares the two consecutive probes; the seam throws the comparison away and
hands over facts whose identity means "newly allocated" rather than "changed".

## Solution

The operator's screen changes only when a fact the operator can read changes.
While the Agents work and nothing moves, the base screen stands still for the
whole turn. A redraw is information: an Agent reached idle, a Ticket state
moved, a Consultation opened or awaited a response, the probe failed and the
plane holds its stale agent observation, or the probe recovered. The operator
stops discounting the screen's motion, and a redraw that lands on a screen
that stood still is worth looking at.

The plane keeps every behavior it shows today - the steady screen, the
marker on a failed probe, the last known standing that survives the failure -
and the change costs the operator nothing to notice.

## User Stories

1. As an operator of the control plane, I want the base screen to stand still
   while the Agents work and nothing has moved, so that I am not re-reading a
   screen that rewrites itself twelve times a minute without showing a change.
2. As an operator of the control plane, I want a redraw of the screen to mean
   that a fact I can read has changed, so that motion on the screen is worth
   looking at.
3. As an operator of the control plane, I want an Agent that reaches idle to
   show its new standing on its row as soon as the cycle reports it, so that
   I can read when a turn has settled.
4. As an operator of the control plane, I want a failed probe to show the
   stale agent observation marker on the screen without any other change, so
   that I know the plane is holding and the Agents are not missing.
5. As an operator of the control plane, I want the last known standing of
   every Agent to stay visible while the probe fails, so that a failed probe
   cannot move an Agent into the recovery flow by itself.
6. As an operator of the control plane, I want the stale agent observation
   marker to clear on the first probe that succeeds again, so that the screen
   returns to the Agents' true standing.
7. As an operator of the control plane, I want a Ticket whose state moved to
   re-derive its row and its section's counts on the cycle that moved it, so
   that the pipeline counts answer the new standing.
8. As an operator of the control plane, I want a Consultation that opens,
   works, or awaits a response to re-derive its row when the cycle reports
   it, so that the Consultation list answers its state.
9. As an operator of the control plane, I want no redraw on a cycle whose
   roster is unchanged, so that the screen cannot flicker on a poll that
   learned nothing.
10. As the control plane, I want to write no screen state when the cycle's
    report is the object I already applied, so that a quiet poll costs me one
    identity check and nothing on the screen.
11. As the control plane, I want the cycle to hand me the same report object
    while its content is unchanged, so that "nothing moved" is a fact I can
    read off object identity.
12. As the control plane, I want the report to name which facts moved, so
    that a new report writes exactly the state the movement names and nothing
    else.
13. As the control plane, I want a failed probe to report its null roster and
    no movement, so that the failure marker appears without touching the
    Ticket or Consultation state.
14. As the developer of the control plane, I want to assert at the
    coordinator's seam that a probe sequence with unchanged content answers
    with the same report object, so that a regression that freshens the
    identity on a quiet cycle is caught where the rule lives.
15. As the developer of the control plane, I want a frame test that drives a
    quiet cycle through the plane and asserts that no frame landed and the
    screen is byte-identical, so that the no-repaint property is proven at
    the screen layer, not assumed.
16. As the developer of the control plane, I want a frame test that asserts a
    failed probe paints the failure marker with no other change to the
    screen, so that the documented failure behavior survives the new report.
17. As the test suite of the control plane, I want to drive the observation
    cycle on a pinned clock with a fake Agent reader, so that a probe
    sequence - working, idle, failing, recovered - is reproducible without a
    live Agent host.
18. As the test suite of the control plane, I want the frame rig to run the
    poll loop at a named interval, so that the steady-state cycles are paced
    by the test rather than the wall clock.

## Implementation Decisions

- The observation coordinator's interface loses the change callback and the
  raw agent list callback, and gains one report callback. The report is the
  seam's only fact about a completed cycle: the cycle's own work - probe,
  settle, dispatch, top-up - is unchanged, and only what the seam reports,
  and who compares, changes.
- The report carries the completed cycle's facts: the probe's roster, null
  while the probe is failing; the Agents that moved between the two
  consecutive probes - a status move, an Agent joining or leaving the
  roster; and the cycle's movement of the Ticket states and the Consultation
  states, the same fact the change callback carried.
- The report's identity is stable on its content. While the report's content
  is unchanged, the coordinator hands back the same report object as the
  previous cycle; only a change earns a new object. Two consecutive failing
  probes report the same object, and a recovery from a failure reports a new
  one, because the content moved from the null roster to a roster.
- The identity rule is computed inside the coordinator module, the only
  place two consecutive probes meet: it already holds the last roster and
  already derives, on every cycle, whether anything moved. The comparison
  rides on the module's existing standing by locality; no other module sees
  the before and the after.
- The plane module consumes the report through its existing screen state
  hooks: it stores the identity of the report it last applied; on a matching
  identity it writes nothing - no state write, no commit, no paint; on a new
  identity it writes the facts the report names: the roster into its screen
  state, the host fact re-derived from the roster, and the Ticket and
  Consultation lists re-derived where the report names their movement. A
  matching report costs the plane one identity check.
- The poll cadence and its contract stand (ADR 0006: the plane polls the
  Agent host, one list call per cycle), as does the agent-wait wake
  (ADR 0084) and the cycle's flow. The decision changes the seam's report,
  not the cycle's work.

## Testing Decisions

What makes a good test: external behavior only, at the seams the rule
crosses.

- At the coordinator's report seam: given a probe sequence, the report's
  identity and content. A working Agent, unchanged across three cycles,
  answers with the same report object on every cycle; the Agent reaching
  idle answers with a new object that names the move; a failing probe
  answers with the null roster and no movement; a second failing probe
  answers with the same object; the first successful probe after the failure
  answers with a new one. The Ticket and Consultation movement facts are
  asserted the same way, from the probe sequence and the state file, not
  from the module's internals.
- At the plane's seam: the plane paints iff the report's identity changed. A
  quiet cycle lands no frame and the screen stands byte-identical; a cycle
  that moves an Agent redraws the screen; a failed probe paints the failure
  marker with no state change and no other change to the screen.

Which seams:

- The coordinator's report seam is the highest existing seam. Unit tests of
  the coordinator already stand there: they wire the real coordinator on a
  fake Agent reader that answers the list probe, a pinned clock advanced by
  the test, a real state file, and the real dispatch module, and they count
  the change callback and read the last roster off the module. The new tests
  extend that pattern by collecting the reports the seam hands over and
  asserting their identity and content.
- The second seam is lower: the frame rig, which boots the plane at a fixed
  size on a fake Agent host, runs the poll loop at a named interval, and
  reads the painted screen. The frame tests already hold the renderer's
  frame events and count the render asks the plane makes; the new frame test
  asserts that a quiet cycle lands no frame and leaves the captured screen
  byte-identical, and that a failing probe's frame carries only the failure
  marker.

Prior art extended:

- The observation suite's coordinator unit tests: a fake Agent reader, a
  pinned clock, a real state file, the callbacks counted, the last roster
  read off the module. The report's identity is collected the way the suite
  counts its callbacks today.
- The frame test style of the suite's view tests: boot the plane, drive it
  with named controls and loops, wait for the frame the behavior should land,
  capture the character frame, and hold the renderer's events and asks so
  that the assertion counts what the plane itself caused.

## Out of Scope

- The renderer's repaint policy - the diffing write against the plane's
  forced full repaint on every frame - is a separate decision (ADR 0145)
  and a separate spec.
- The tick clock's drift, the next cycle scheduling after the previous one
  finishes rather than on a fixed period, is a separate candidate.
- The per-terminal probe fan-out, the merged reader's sequential
  per-terminal reads on the herdr-core host, is a separate candidate.
- The poll cadence: ADR 0006 stands. The plane polls the Agent host, one
  list call per cycle; this decision changes what the cycle reports, not how
  often it probes.
- The other deepening candidates of the render path audit - the plane's
  re-derivation of every region on any state write, the pane body
  re-derivation on every tick, the spinner and the pop-in as state ticks,
  the base screen standing under every overlay - are separate specs.

## Further Notes

- Interaction with ADR 0145: with the diffing write restored at the
  renderer's seam, a no-op report costs the plane one identity check and
  nothing on the terminal, and the quiet cycle is invisible. Without that
  decision, the quiet cycle still lands no frame at all - the plane writes
  no state, so nothing is painted - but the plane's other ticks, the
  spinner, the body refresh, and the Live view's stream, still rewrite the
  whole screen on every commit, and the operator's visible win stands
  partial: the screen stops churning on the poll's cadence and keeps
  churning on the rest.
- The report's null roster is the seam's one standing case where content
  moves while no Agent, Ticket, or Consultation moved: a transition between
  a successful probe and a failing one, in either direction, is a change
  under the content rule, and the identity rule names it the same way it
  names every other change.
