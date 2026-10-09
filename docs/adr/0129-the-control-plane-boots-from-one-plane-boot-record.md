# ADR 0129: The control plane boots from one Plane boot record

Status: accepted
Date: 2026-10-09

Records that the control plane boots from one record whose every field stands,
that which background loops a run starts is a named Loop policy inside that
record, and that the test-only projection plane is retired. It moves no control,
changes no key, rewords no hint, and touches no surface. It adds one stop to the
production shutdown path, which is a reliability change and not a test change.

## Context

The App shell module boots from ten fields, and nine of them are optional. Only
the config is required. The interface cannot say which fields a running plane
always needs and which one particular test left out, because it says "maybe" to
nine of them. The App shell carries the answer in its implementation instead: it
checks for an absent field 63 times at head `6f06dba5` (47 `=== undefined`, 8
`!== undefined`, 8 optional-chain), and fills four more absences with its own
defaults - a real child-process runner, the process's own home directory, the
default config path, and an empty source set.

The production entry supplies six of the ten and never supplies the other four:
the home directory, the in-memory Ticket projection, the rig's poll interval, and
the teardown handle. The App seam itself is not the problem. It is one seam with
exactly two render sites, the production entry and the Frame rig, and both render
the same module.

Those absences add up to a second control plane inside the UI module. A run with
no state file:

- reads its Ticket list from `inMemoryTicketViews`, which sets `active` to the
  rows and `ignored` and `muted` to empty, with no sort and no fixing-pull-request
  filter. The real list rule, `listTicketViews`, stands directly beside it in the
  state module and does all three;
- starts no refresh coordinator and no observation cycle;
- keeps its own Handoff bookkeeping, with its own stored fact and its own list
  patch, beside the Handoff dispatch module the plane actually owns;
- hands back no teardown handle, because the handle is made only on the branch
  that starts the loops.

The Frame rig picks that plane by default: a suite that names no state and no
source gets the sample Tickets and no loops. Twenty frame suites touch this mode,
130 call sites name it directly, and 23 of the 553 `withApp` calls pass no fields
object at all and land on that default. Most of those suites are about painted
layout, so the suites that draw the section counts, the held-count bell, and the
launcher's repository choices never read the list rule those facts come from.

Three costs follow, and each is already measurable.

**The list on the screen is not the list the factory shows.** In the 20 suites
that touch the projection plane, the `ignored` and `muted` Ticket views are always
empty and the machine's `active` view equals the operator's rows. A mutant in the
list rule is killed by the state module's own suite and by nothing on the screen.

**A second implementation of the plane's own acts sits in the UI module.** The
no-state Handoff fact, its in-flight reference, and its list patch are 23 named
sites inside the App shell, reachable only from tests, and they are not the
plane's start path.

**Production has the ordering hazard the rig already names.** The teardown handle
exists only where the observation cycle starts, and the production entry never
takes it. `installStateShutdown` closes the state file on exit, `SIGTERM`, and
`SIGHUP` with no loop stop. The rig's own comment states why the order matters: a
Handoff settlement that lands after the state closes reads a closed database. The
production run has the same race and no handle to close it.

## Decision

**The Plane boot is total.** The App shell takes the validated config, the
Command runner, the config file path, the home directory, the state aggregates,
the bound Ticket sources, and the file logger. Every field stands. The state
aggregates stay the narrowed view the shell already reads, the eight aggregates
plus the state clock, so the shell still never reaches the state file and still
never holds the lease (ADR 0095). The production entry fills the record from the
startup module's success result, which already carries every field except the home
directory, and resolves the home once. The four `??` defaults leave the module.

**The Loop policy is named, not inferred.** Three cases stand in the record:
production, which polls the Ticket sources and the Agent observation at the
config's interval; held, which starts neither; and polled, which starts both at an
interval the rig names in milliseconds. The branch that switches the observation
cycle off when a field is absent retires, and the policy decides. The config's
`agent-poll-interval-seconds` stays a whole-second operator value, so the rig's
fast poll stops being a test-only slot on the plane's interface.

**The teardown handle stands on every branch, and production takes it.** The
handle becomes unconditional. The production entry wires the same stop into
`installStateShutdown` beside the state close, so a signal-stopped run stops the
refresh coordinator, the observation cycle, and the Handoff dispatch module before
the state file closes. This is the one consequence an operator feels, and it lands
on its own, ahead of the suite migration.

**The projection plane retires.** The in-memory Ticket projection slot leaves the
interface, and every frame suite boots a real state file seeded through the state
module, which is what the Seeded plane already does for the flow suites. The
no-state Handoff fact, its in-flight reference, and its list patch are deleted: a
Handoff start goes through the Handoff dispatch module, which is the plane's one
start path (ADR 0097). `inMemoryTicketViews` is expected to retire with them and
keep only its own suite as a reader; whether it does is a measurement taken when
the last no-state caller goes, and the change that removes it records the answer.

**The rig's boot takes the Seeded plane.** The Frame rig takes one Seeded plane
plus a Loop policy and produces the Plane boot. The per-suite boot records, their
`SeededApp` shapes, and their `propsOf` helpers retire, and the rig's branch that
decided which dialect a suite was using disappears with the dialects.

**A declared rule pins the seam.** Following the eight existing architecture
checks, one check reads the App shell's source and refuses an absence check on a
field the Plane boot makes required, a `??` default that fills a boot field, and
the retired slot names wherever they stand. It states its own unread shapes the
way the shared-control and view-ownership checks do, and the frame seam owns those
shapes.

**The migration order is fixed.** The Plane boot and the Loop policy land first,
with the projection slot still present but refused for any suite that has not
moved. Frame suites then move surface by surface, each surface's frames re-pinned
as it moves. The projection slot and the no-state bookkeeping are deleted last, in
the change that moves the last suite off them. The production teardown change
lands before all of it.

## Considered options

- **Keep the projection plane and name it instead of inferring it.** Rejected: it
  keeps a second Ticket-list rule and a second Handoff start path in the UI
  module, which is the shallowness this decision removes. A named wrong plane is
  still the wrong plane, and 20 suites would still assert on a list the factory
  never shows.
- **Let the config carry a sub-second poll interval and drop the rig slot.**
  Rejected: it puts a test's pace into an operator-facing setting and lets a
  config file start an observation cycle every 20 ms.
- **Add a second App module for tests.** Rejected: two UIs is two implementations
  of every surface, and the gallery standard already refuses a surface that
  imitates the plane instead of being it.
- **Leave the production shutdown alone and only fix the rig's stop.** Rejected:
  the hazard is the run's, not the test's. The rig already stops in the right
  order, and production is the side that does not.
- **Make the boot record total but keep the no-state Handoff bookkeeping for
  speed.** Rejected: it keeps a second start path, and ADR 0097 already decided
  the start is one call.
- **Widen `AppProps` with a discriminated union of the same optional fields.**
  Rejected: it keeps nine optional fields behind a tag, and the caller still
  learns the invariants per branch rather than from the record.

## Consequences

One interface stands at the App seam, and it states one set of invariants. A
contributor cannot boot a plane that is missing its state, its sources, or its
config file, and a test cannot reach the projection plane by forgetting to name a
state.

Every frame suite reads the real list rule, so the `ignored` and `muted` views and
the machine's `active` view are live facts in the suites that draw them, and a
mutant in the list rule gains screen coverage it does not have today.

The App shell module loses 63 absence checks, four defaults, and its copy of the
Handoff start. What is left of it is the surface and the loops.

A signal-stopped production run stops its loops before it closes its state file.
The race the rig already guards against stops existing on the operator's side.

The cost is real and named: 20 frame suites move, each with its frames re-pinned,
and the suites that existed only to cover the projection plane are deleted rather
than migrated. The change that lands each step records the count of suites moved,
frames re-pinned, and suites deleted, at the head it measured them on, and names
each deleted suite. A frame that changes during a move states the frame it moved
to and why, so a re-pin is not read as a behaviour change.

This decision claims no screen-reader support, and it does not touch the CI
frame-test flake, which stays open in
[the quality gate verification record](../verification/quality-gate.md).

Issue [#366](https://github.com/SeriousJul/my-little-software-factory/issues/366)
is the spec for this change. Issue
[#362](https://github.com/SeriousJul/my-little-software-factory/issues/362), the
Seeded plane, is its dependency: the rig's boot has nothing to take until that
lands. Issue
[#361](https://github.com/SeriousJul/my-little-software-factory/issues/361) is
independent and changes what the Command runner double answers, not what the Plane
boot carries. Issues
[#360](https://github.com/SeriousJul/my-little-software-factory/issues/360) and
[#363](https://github.com/SeriousJul/my-little-software-factory/issues/363) give
the duplication count this change is measured against.

The glossary names the **Plane boot** and the **Loop policy**, and the **Seeded
plane** entry now names the Plane boot rather than "the props the App boots from".
As with ADR 0122 and ADR 0128, the decision and the terms land before the change
they govern does.
