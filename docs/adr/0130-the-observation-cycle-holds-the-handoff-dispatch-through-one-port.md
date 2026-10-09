# ADR 0130: The observation cycle holds the Handoff dispatch through one port

Status: accepted
Date: 2026-10-09

Records that the observation cycle holds the Handoff dispatch module through one
Observation dispatch port that names the four calls the cycle may make, that the
cycle reads the Auto-handoff mode from the state it already holds and keeps one
clock for its facts and its scheduling, and that the observation suite drives the
real Handoff dispatch module instead of restating its rules. It moves no control,
changes no key, rewords no hint, decides no gate, and touches no surface.
Amended by ADR 0133: the port's call set gains a fifth call,
`planeActionRunInFlight`, the Plane action's run mark (ADR 0104), which the
cycle's ask step reads as a standing gate before it asks (issue #352). The
mark's read rides with the other seams in the port's implementation, and does
not drop when the port lands. The four calls it names stand.

## Context

The observation cycle is the factory's automatic heart: each poll it reads herdr,
settles the turns that ended, decides each completion, runs the Pickup, and makes
the one Top-up add. Its module interface, `ObservationOptions`, carries **23
fields** at head `dfb6b8e0`, and its caller hand-builds eight to ten of them.

Four of those fields are not the cycle's own collaborators. They are four loose
functions re-projected from the Handoff dispatch module, which is the module the
plane owns for every start (ADR 0049, ADR 0097): `dispatch`, `dispatchPlaneAction`,
`pickupWorkQueue`, and `cleanup`. The fourth is a field-by-field projection of
`HandoffTicket` onto `StoredHandoffFacts`, written in the App shell, of a method
the dispatch module already owns under another name.

Because the cycle receives those four as functions rather than the module that
owns them, the observation suite restates the module's rules in its own rig. The
rig in `test/observation.test.ts` spans lines 193 to 419 - **227 lines, 175 call
sites** - and writes straight to the state:

- `workQueue.enqueueWork` and `workQueue.enqueuePlaneActionWork`, which are the
  dispatch module's enqueue (ADR 0049);
- `handoff.claimHandoff`, which is the dispatch module's claim and its hard start
  checks;
- `handoff.settleHandoff(..., false, reason)`, which is the dispatch module's
  failed-start settle;
- `ticketWorkCycle.applyCompletionDecision`, which is the route's decision at the
  ask (ADR 0064);
- the held `onStarted` queue, which is the dispatch module's start report.

Seven direct state writes, and **221 tests with 631 assertions** stand on them.
That file is the most-churned test file in the repository: **21 touches in the
last 120 commits**.

**The suite cannot see the rules it depends on.** A change to the one-item-per-ticket
rule, the claim's hard checks, the route-decision-at-the-ask, the Pickup's order
(ADR 0094), or the start-report timing does not fail the observation suite,
because the suite never runs the code that owns those rules. The rules are
asserted where they live, in `test/handoff-dispatch.test.ts` and the state
module's own suites, and that is the coverage the observation suite believes it
has. It does not: the cycle's own gates read a start path the rig invented.

**The fidelity gap is measured.** Only **7 of 175** rig call sites pass a
`fireCompleted` seam at all, so most cycle tests run a machine with no Transition
(ADR 0027). The cycle's completion decision, its Next step, and the Top-up's
position reads are tested against a hand-supplied `TransitionOutcome`, while the
real fire runs in `test/workflow-transition.test.ts` and
`test/auto-handoff-chain.test.ts`.

Six further shallowness leaks stand in the same interface, each measured at the
same head:

- **Two time seams.** `now` is read 8 times and `clock` 2 times. The rig pins both
  and keeps them consistent by hand, so a rig can age the state file and not the
  cycle, or the reverse.
- **`mode` re-supplies factory state.** The Auto-handoff mode is a fact on the
  state file (ADR 0036 as amended by ADR 0092), the cycle already holds the
  Handoff aggregate that answers it, and the App keeps a third copy in a reference
  it writes on the `a` key.
- **`intervalMs` is derived by the caller** from the config the cycle already
  reads each cycle.
- **`startupGraceMs` is passed back to the module as the module's own exported
  constant**, and `reconcileOnly` is passed `true` by the App and by no test while
  the module's own default is `false`.
- **Three fields default to a production adapter inside the module** - `log`,
  `clock`, `turnLogs` - so the module constructs the real session-record reader and
  the system clock when a caller says nothing. One production caller exists, so
  those defaults serve no caller and hide which adapter stands.
- **Two report callbacks, one a subset of the other.** `onChanged` re-reads
  Tickets and Consultations; `onConsultationsChanged` re-reads Consultations only.

`pickupWorkQueue` is optional on the interface and the cycle guards every call to
it, while the App always supplies it: the branch stands for an app that does not
exist.

## Decision

**The cycle holds the Handoff dispatch module through one port.** One interface
names the four calls the cycle may make: `dispatch`, `dispatchPlaneAction`,
`pickupWorkQueue`, and `closeCleanup`. The Handoff dispatch interface extends it,
so every dispatch module already satisfies it and the App passes the module it
builds, unchanged. The cycle's reach is bounded by a type: it cannot name
`forceDispatchWorkQueueItem`, `removeQueueItem`, `removeConsultationQueueItem`,
`closeWorkCycle`, `handoffActive`, or `stop`, which are the operator's calls and
the run's teardown, not the cycle's.

`pickupWorkQueue` becomes required on the port, and the cycle's absent-queue guard
retires with it.

**`cleanup` leaves the interface.** The cycle calls `closeCleanup` with the Handoff
facts it already holds. The App's projection of `HandoffTicket` onto
`StoredHandoffFacts` moves inside the dispatch module, which already takes the
Ticket identity as a separate argument.

**One clock serves the facts and the schedule.** The cycle takes one clock that
answers `now()`, `setTimeout`, and `clearTimeout`, and uses it for both. The
refresh clock gains `now()`, which the refresh coordinator ignores, so one object
serves the state file, the refresh coordinator, and the cycle, and a Seeded plane
hands them the same pinned value.

**The cycle reads the Auto-handoff mode from the state.** The cycle reads the
Handoff aggregate's mode fact at the start of each cycle, which is what the
field's own comment already states it does. `mode` leaves the interface. The App's
reference stays for rendering, and the `a` key writes the state first and the
reference second, so the reference follows the state instead of standing beside it
as a third copy.

**The cycle derives its own interval, and owns its own constants.** The poll
interval derives from the config the cycle reads each cycle, and the Loop policy
(ADR 0129) carries the interval a test names rather than the App computing it. The
App stops passing the Startup grace constant back to the module that exports it,
and the reconcile-only standing becomes the module's own. A test that needs a
different grace names it.

**No field defaults to a production adapter.** `log`, `clock`, and `turnLogs` are
supplied by the caller. The module stops constructing the real session-record
reader and the system clock behind a caller's silence.

**One report callback.** `onChanged` covers both, and the cycle calls it at the two
Consultation-only points as well. The cost is a Ticket re-read at two moments that
did not need one; the benefit is one report shape and one field gone.

**The Transition fire stays a port, and the suite runs the real one by default.**
`fireCompleted` and `refireRecordedSkips` stay on the interface: the fire belongs to
the workflow module and the source writes, not to the cycle, and pulling it in
would widen the cycle's implementation in the wrong direction. The rig stops
omitting them: it wires the real fire over the same config, state, and Command
runner the App wires, and a test that wants a hand-supplied outcome names one.
Every gap that exposes is filed as an issue in the same push, per the standing
"a defect found is a defect filed" rule, and no assertion is loosened to close one.

**The observation rig converges on the Seeded plane, and its mirrored rules are
deleted.** The rig and the acceptance-chain rig meet on one fixture that opens a
real state file on one pinned clock, builds the real Handoff dispatch module over
the Command runner double, hands the cycle that module, that clock, and the real
fire, and returns only the cycle's own report reads. `test/auto-handoff-chain.test.ts`
is the model, and that file is not rewritten: it already builds the real dispatch
module and passes its methods through. The rig's `setAutoMode`, `dispatchClaims`,
`startFails`, and its held `onStarted` queue retire. A test that wants a refused
start leaves the state in the standing fact that refuses it, the way the plane
does, and the real module refuses it.

**A declared rule pins the seam.** Following the eight existing architecture
checks, one check reads the suite and refuses a test file outside the state
aggregate suites writing `workQueue.enqueueWork`, `workQueue.enqueuePlaneActionWork`,
`handoff.claimHandoff`, or `ticketWorkCycle.applyCompletionDecision` to drive a
cycle. It states its own unread shapes and its allowance list beside its reason,
the way the shared-control and view-ownership checks do. Where the check cannot
stand, that is recorded as an open item rather than passed over.

## Considered options

- **Hand the cycle the whole Handoff dispatch module.** Rejected: the dispatch
  interface carries ten methods, and six of them are the operator's and the run's.
  It would widen what the cycle may reach while narrowing what it must learn. The
  port does both, and the dispatch interface extending it costs nothing.
- **Let the cycle build and own its dispatch module.** Rejected: the App shell
  owns the dispatch module's lifetime because it outlives the cycle across a
  config write-back, and a stopped dispatch module is a plane that starts nothing
  for the rest of the run. The cycle must not own a thing that outlives it.
- **Keep the four functions and move the rig's mirrored rules into a shared test
  helper.** Rejected: that keeps a second implementation of the start path, one
  copy in production and one in the suite, which is the shallowness this decision
  removes. A shared wrong copy is still a wrong copy, and it would still not fail
  when the real one changes.
- **Give the cycle the Command runner and let it fire the Transition itself.**
  Rejected: the fire is the workflow module's act on the source through the
  Command runner, and ADR 0095 and ADR 0096 already place that work elsewhere. The
  cycle would gain the source writes it has no business owning.
- **Leave `mode` as a callback because the App renders from it.** Rejected: the
  mode is factory state, the cycle already holds the aggregate that answers it,
  and the callback is the third copy of one fact. The App's reference is a render
  concern and stays one.
- **Fold the observation suite into the frame suites and delete it.** Rejected:
  the cycle's gates - the Top-up's step order, the Dispatch pause, the Startup
  grace, the Missing agent reading, the standing-fact reports - are cycle facts,
  and testing only through the App seam would make each one a frame test. The
  cycle's own interface is the right seam for them, and this decision makes that
  seam honest rather than removing it.

## Consequences

The observation interface drops from **23 fields to 16**, of which 10 are
required. Four fields collapse into one, two time seams become one, two report
callbacks become one, and three hidden defaults become three supplied adapters.

The cycle's start path is the plane's start path in every observation test. A
change to the enqueue, the claim's hard checks, the one-item-per-ticket rule, the
route-decision-at-the-ask, the Pickup's order, or the start-report timing fails
the observation suite, because the suite runs the module that owns each of them.

The rig loses its seven direct state writes and the options that exist only to
drive them. The tests that existed to drive those copies are deleted rather than
migrated, and the change that deletes each names it, so a deletion is not read as
a lost assertion.

The Transition fire stands in most cycle tests instead of 7 of 175. That is a
fidelity increase, and it is expected to expose real gaps. Each is filed, and the
record states which the change closed and which stand open. This decision claims
no gap was closed that was not measured.

The App shell stops restating the cycle's own constants and stops projecting the
cycle's cleanup argument. The cycle's clock, the state file's clock, and the
refresh coordinator's clock become one object, so a rig cannot age one and not the
others.

The cost is real and named: the rig convergence is the bulk of the work, and the
221 tests that stand on the current rig are re-read against the real start path.
The change records the field count, the rig's line count, the direct state-write
count, the test count, and the deleted-suite names at the head it measured them
on, and one full `bun run test` on the merged tree with the machine state beside
it. A file that fails in the full suite and passes alone is named as a load flake,
and the CI frame-test flake stays open in
[the quality gate verification record](../verification/quality-gate.md); this
decision does not touch it.

Issue [#364](https://github.com/SeriousJul/my-little-software-factory/issues/364)
is the spec for this change. Issue
[#362](https://github.com/SeriousJul/my-little-software-factory/issues/362), the
Seeded plane, is its dependency for the rig convergence: the fixture this decision
converges on is the one that spec builds, and the two do not both open a state
file. Issue
[#361](https://github.com/SeriousJul/my-little-software-factory/issues/361) is
independent and changes what the Command runner double answers, not what the cycle
holds. ADR 0129's Plane boot and Loop policy own the interval and the boot record
this decision reads from, and ADR 0097's one start call is the reason the port has
one module behind it. Issues
[#360](https://github.com/SeriousJul/my-little-software-factory/issues/360) and
[#363](https://github.com/SeriousJul/my-little-software-factory/issues/363) give
the duplication count this change is measured against.

The glossary names the **Observation cycle**, the **Handoff dispatch**, and the
**Observation dispatch port**. As with ADR 0122, ADR 0128, and ADR 0129, the
decision and the terms land before the change they govern does.
