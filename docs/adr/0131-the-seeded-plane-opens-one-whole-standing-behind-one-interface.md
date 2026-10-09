# ADR 0131: The Seeded plane opens one whole standing behind one interface

Status: accepted
Date: 2026-10-09

Records that the suite's per-file boot preambles collapse into one **Seeded plane** module with one
interface and no new seam, that the standing a test names is stated in the domain's own words, that
one default Ticket, one Repository, and one derived herdr Agent name serve the whole suite, that the
state module's own suites stand outside the fixture, and that a declared rule refuses a frame suite
opening a state file by hand. It moves no control, changes no key, rewords no hint, decides no gate,
and touches no surface.

## Context

ADR 0129 settled the App seam: one total Plane boot, no optional field, no projection plane. That
decision says what a boot record must carry. It does not say who builds one, and today every suite
builds its own.

Measured at head `066e7f72`, the suite is the larger body of code and the more duplicated one:
**114,553 lines over 166 files** against **65,551 lines** in the plane's own sources. **42 frame
suites** hold **557** rig boot sites, and **21 of them also open a state file by hand**, so they
carry two ideas of how a plane starts.

The boot preamble is written again per file, and the copies disagree:

- `stubCheckout` stands in **9** test files. `seededApp`, `SeededApp` and `propsOf` stand in **3**
  each, each with a different signature; `SeedDetail` in **2** with different fields; `seed` in
  **4**; a `fetched` Ticket builder in **9**; the one-source config in **6**.
- **573 local helper functions** stand across **102** test files, of which **50** are named standing
  builders (`stub*`, `seed*`, `make*`, `write*`), and **8** of those stand in two or more files.
- **119 temporary-directory creations across 40 files**, and **18** files own their own directory
  cleanup block.
- **100 Grouping axis writes across 22 files**, because a fresh state file opens grouped by
  repository while most frames assert the flat list. **7** files repeat the same comment explaining
  that trap to the reader.

**The suite has three different default Tickets.** One shared fixture names it "Add a webhook retry
policy", a second names it "Persist source facts", a third names it "Retry policy for webhooks". The
herdr Agent name the naming rule derives (ADR 0098) is then re-derived by hand: **38 `agentNameFor`
call sites across 12 test files, 14 of them fed a hand-typed title literal.** A rule can pass
against one Ticket and never be read against another, and a naming-rule change lands in twelve
files.

The consequence is not length. It is that a fact the plane owns has no single place to live. The
sample Ticket's shape lives in nine builders, the fresh-file Grouping axis lives in 22 files, the
naming rule's answer lives in 12, and the state file's lifetime lives in 40. A change to one plane
fact is a change to many test files, and a test can pass on a fixture no other reader would build.

The duplication is already measurable and already outside every check. At the audit's own settings
(`minTokens: 100`, `minLines: 5`, jscpd 5.4.0), the plane's sources hold **0 clones** and the suite
holds **267 clones across 5,098 duplicated lines**, 4.44% of its scope. Issue
[#360](https://github.com/SeriousJul/my-little-software-factory/issues/360) puts the suite in the
audit's scope; issue [#363](https://github.com/SeriousJul/my-little-software-factory/issues/363)
shrinks the count this change is measured against.

Two shared fixtures already exist, and neither was deep enough to be used: the app-level state
fixture and the state aggregate suites' shared fixture. Each suite built a third.

## Decision

**One Seeded plane module, one interface, no new seam.** One entry point takes the standing a test
wants and returns the whole plane: the state file, the config file, the home and checkout
directories, the Command runner double, the Ticket source double, the clock, and the Plane boot ADR
0129 settled. The module composes three seams the plane already has - the state module's open seam,
the Command runner seam, and the Ticket source seam - and presents their composition at the App seam.
It adds no port the production plane calls, and no indirection in the plane's own sources. One
adapter already stands at each seam on each side: the child-process runner in production and the
double in tests, the real sources and the double, the state file in both.

**The standing is stated in the domain's words, not the suite's.** The Ticket states are `open`,
`handed-off`, `running` and `awaiting`, and a work cycle ends at a close (ADR 0005). The standing a
test names is `open`, `in-flight`, `awaiting`, or `closed-cycle`; the last is the claim, the settle,
the turn, and the close decision that three fixtures currently spell out by hand. The per-file
`shape` unions retire.

**A field is admitted only when it names a fact of the plane.** This is the depth rule, and it is
the rule the two existing shared fixtures failed at. A field that names an aggregate call, a
directory, or a step of the build is refused at review. Where building a standing needs a rule the
plane owns - the naming rule, the work-cycle rule, the Transition fire - the module calls the module
that owns it rather than reproducing it, so no test can pass because a fixture restated a rule.

**One default Ticket, one Repository, one derived herdr Agent name.** A shared fact module holds the
fetched Ticket, the fetch outcome, the Handoff choice, the Repository reference, and the workflow
States the projection matches against. The Seeded plane and the state aggregate suites both read
that module, and the three default Tickets resolve to one. The herdr Agent name is derived from that
Ticket once, so the 14 hand-typed derivations retire with the literals they were fed.

**The Grouping axis default is the flat axis.** The fixture settles the flat axis and takes the
repository axis as a named field, because a frame that wants the split is the exception and says so
in one word. The 100 per-file writes and the 7 repeated comments go with it. This is the rule the
app-level fixture already holds; it becomes the suite's.

**One clock serves the state file and the test.** The fixture opens the state file on a clock it
owns and hands that clock back, so a case ages a stored Handoff past its Startup grace without a
wall-clock wait, and the per-file `stateNow` fields retire. ADR 0130 makes that one clock serve the
refresh coordinator and the observation cycle as well; the fixture is where all three get the same
pinned value.

**The app-level state fixture is absorbed, and the state aggregate suites' fixture stays and
shrinks.** Its state opener, one-source config, sample Ticket, fetch outcome builders, in-flight and
awaiting seeders, and source-call wait move into the Seeded plane. The aggregate suites' fixture
keeps only what belongs to it: the state-file path, the cleanup, and the tools that corrupt or
downgrade a state file on purpose. Those tools exist for tests that test the state file, and they
stay outside the fixture.

**The state module's own suites stand outside the Seeded plane.** They test the state module through
its per-aggregate interface (ADR 0095), and several need a hand-corrupted database. A fixture
between a test and the seam that test exists to read would hide that seam. The same holds for the
module suites - the Handoff dispatch, the observation cycle, the acceptance chain, the top-up, the
checkout hold, the Plane action merge: they take the plane's parts, and the Plane boot is one part
they ignore.

**The Frame rig takes the Seeded plane.** ADR 0129 already decided this and owns the Plane boot the
fixture fills. This decision adds only the fixture's own shape: the rig takes one Seeded plane plus
a Loop policy, and the per-suite boot records, their `SeededApp` shapes, and their `propsOf` helpers
retire.

**A declared rule pins the seam.** Following the eight existing architecture checks, one check reads
the suite and refuses a test file that reads the frame rig also opening a state file directly.
**21 files fail it today**; the check lands in the change that clears the last one. It states its
own allowance list beside its reason, the way the shared-control and view-ownership checks do: the
state aggregate suites are allowed, because opening the state file is what they test.

**The migration order is fixed, and the ratchet is measured.** Issue
[#360](https://github.com/SeriousJul/my-little-software-factory/issues/360) lands first, so the
suite's duplication count is visible before any of it moves. Then one suite per change, largest
first, each reporting the clone count before and after at the head it measured them on: the
unattended-mode suite, the Plane action merge suite, the Handoff frame suite, the Live view suite,
the Handoff suite, the Handoff dispatch suite, the Consultation frame suite, the Consultation
operations suite, the rest. The shared fact module lands before the first suite moves, because it
carries a defect of its own. The static check lands last.

## Considered options

- **Keep the two shared fixtures and add a third shared helper.** Rejected: two shared fixtures
  already exist and neither was deep enough to be used, so each suite built its own. A third helper
  meets the same fate, and it leaves three default Tickets in place.
- **Pull the state aggregate suites into the Seeded plane for one fixture everywhere.** Rejected:
  those suites test the state file, and several corrupt or downgrade it on purpose. A fixture in
  front of the seam a test exists to read hides that seam, and ADR 0095's eleven declared rules are
  read through it.
- **Make the fixture a thin builder over the nine aggregates, with one option per aggregate call.**
  Rejected: that is the shallow shape this decision exists to avoid. The interface would be nearly
  as wide as the sequence it hides, and the caller would still learn the aggregates.
- **Put the seam at the state module instead of the App seam.** Rejected: it is a lower seam, so the
  frame suites would still assemble the Plane boot by hand, and the 21 hand-opened state files
  would stay. The highest seam available is the App's, and ADR 0129 already made it honest.
- **Resolve the three default Tickets without building the Seeded plane.** Rejected: it fixes one
  drift and leaves nine Ticket builders, three boot records, three `propsOf` helpers, and 119
  temporary directories. The drift and the preamble are the same shallowness read twice.
- **Land the Stub herdr world first.** Rejected: issue
  [#361](https://github.com/SeriousJul/my-little-software-factory/issues/361) changes what the
  Command runner double answers, and the world has nowhere to be handed to until one module owns the
  runner every suite gets. The fixture is that owner; the world is one adapter behind it.

## Consequences

One place stands for the sample Ticket, the fresh-file Grouping axis, the clock, the temporary
directories, and the Plane boot. A Ticket-shape change lands in one module instead of nine files, a
naming-rule change in one instead of twelve, an axis rule in one instead of twenty-two.

The suite gains the ratchet the plane's sources already have: the clone count is reported at each
step and only falls, and the static check refuses the two ways a suite can opt back out - a
hand-opened state file, and a hand-built default Ticket.

The state module's suites keep their seam, and the module suites keep theirs. The suite ends with one
app-level standing, one database-level tool set, and one set of fact builders between them.

The cost is real and named: 42 frame suites and the module suites move, one per change, and 21 files
lose a state file they opened by hand. The migration is behavior-preserving. A step that changes an
assertion is a step that found a defect, and that defect is filed in the same push rather than
folded into the migration. Each change records the clone count, the suite count moved, and the
hand-opened state count at the head it measured them on, with the machine state beside one full
`bun run test` on the merged tree. A file that fails in the full suite and passes alone is named as
a load flake, and the CI frame-test flake stays open in
[the quality gate verification record](../verification/quality-gate.md); this decision does not
touch it. This decision claims no screen-reader support.

Issue [#362](https://github.com/SeriousJul/my-little-software-factory/issues/362) is the spec for
this change. Issue
[#360](https://github.com/SeriousJul/my-little-software-factory/issues/360) blocks it: the
duplication scope lands first so every later step is measured. Issue
[#363](https://github.com/SeriousJul/my-little-software-factory/issues/363) holds the count this
change drives down. Issue
[#366](https://github.com/SeriousJul/my-little-software-factory/issues/366) (ADR 0129) owns the
Plane boot and the Loop policy the fixture fills, and depends on this one: the rig's boot has
nothing to take until the Seeded plane lands. Issue
[#364](https://github.com/SeriousJul/my-little-software-factory/issues/364) (ADR 0130) converges
the observation rig on this same fixture, and the two do not both open a state file. Issue
[#361](https://github.com/SeriousJul/my-little-software-factory/issues/361) is independent and
lands at the Command runner seam behind this module's runner.

The glossary's **Seeded plane** entry now names the standing a test drives and states that the state
module's own suites stand outside the fixture. As with ADR 0122, ADR 0128, ADR 0129, and ADR 0130,
the decision and the terms land before the change they govern does.
