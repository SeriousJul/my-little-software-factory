# The Seeded plane verification

Status: the Seeded plane opens the whole control plane behind one interface,
and the migration has moved the frame suites onto it. Every frame suite now
opens its state through the plane's props. The module suites the plane serves
take the plane's parts; the module suites it does not serve stand on the
state module's own interface, and the state aggregate suites stay on that
interface by the decision itself. A static check refuses the two ways a frame
suite can opt back out: opening a state file by hand, and spelling the
default Ticket's title by hand. It landed in this same change, the way the
plan for it names. The full suite passes on the merged tree, and the
`test-dup` count the Quality audit ratchets stands at the value this
branch's baseline holds, below the count `origin/main` carries. The spec's
one sentence the plane does not hold - that no case reads wall-clock time -
is honored by the suites' discipline and recorded below as a deviation. A
check that could not run is recorded as incomplete below. It is not a pass,
and it is not silently dropped.

See [ADR 0131](../adr/0131-the-seeded-plane-opens-one-whole-standing-behind-one-interface.md)
for the decision, [issue #362](https://github.com/SeriousJul/my-little-software-factory/issues/362)
for the requirement, [the Seeded plane's term in the glossary](../../GLOSSARY.md),
and [test/plane.ts](../../test/plane.ts) for the module.

## What it was measured on

| Piece | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (Linux x64) |
| Test layer | `bun test` on the unit layer: the real App against a real SQLite state file on a temp path, the fake command runner and the Stub herdr world at the runner seam, and no desktop control |
| Plane module | [test/plane.ts](../../test/plane.ts), one `plane` factory, its `Plane` record, and its `withPlane` form |
| Plane suite | [test/plane.test.ts](../../test/plane.test.ts), 48 cases on the module's own standing, beside the [test/plane-cleanup.ts](../../test/plane-cleanup.ts) preload that owns the close of every plane the run's tests open |
| Fact module | [test/fact-fixtures.ts](../../test/fact-fixtures.ts), the one default Ticket, the fetched-Ticket and fetch-outcome builders, the Handoff choices, the repository references |
| Static check | [test/seeded-plane-check.test.ts](../../test/seeded-plane-check.test.ts), 4 cases: a frame suite that imports the frame harness, in its own directory or a subdirectory's, must not open a state file by hand, and must not spell the default Ticket's title by hand |
| Suite size | 152 test files; the full suite green on the merged tree: 3,358 pass, 0 fail |

## The interface, against the spec's standing

The spec names the standing a case can ask the plane for. The table states
each field's answer: the field stands, or the plane refuses it and names what
the cases use instead.

| Standing the spec names | The plane's answer |
| --- | --- |
| The work cycle of the default Ticket: `open`, `in-flight`, `awaiting`, `closed-cycle` | `standing`, with `turn` and `handoff` beside it |
| The tickets a source lists | `tickets` on the default source, or `sources` for the named list |
| The stored handoffs beside the default Ticket | `handoffs` |
| The Consultation records | `consultations` |
| The Work queue rows | `queue` |
| The muted sources | `mutedSources` |
| The ignored tickets | `ignoredTickets` |
| The repository init facts | `repositoryInits`: the repository to the settings hash that made the init commit. The spec's `repositoryInit` names one repository; the field generalizes it to the table, because a plane can stand more than one repository initialized, and the state module's own fact is already the table |
| The workflow States the machine runs on | refused as a field. A case that needs a state the base config does not carry passes it on `config.workflowStates`, the config override the plane resolves, and the plane's resolved config is the one the App boots from. A `machine` field would name the build's input, not a fact of the plane's standing |
| The checkout beside the default repository | `checkout` and `repos`, the `[repos]` mapping |
| The clock | `now`, the base the plane's clock stands on; the plane hands its clock back |
| The loop policy | `loopPolicy` on the plane's props, from `pollIntervalMs` |

Beside the spec's standing, the interface admits the fields a case names on
its own: the home and the state file the case opens or paths, the wrapped
state and its axis, the preparation of the home, the settled reads of the
standing's sources, the settlement the source doubles run on, the named
source lists and their null entries, the factory-state fields, and the runner
and command fields. The plane suite holds a case for every field the
interface admits, beside the table above, and reads each one back through the
state module's own interface. One field stands apart from the depth rule the
ADR names, and the record states the reason the plane keeps it: `prepare`
names a step of the build, the preparation of the home once it exists. Three
suites stand facts that depend on the home's own paths before the standing can
name them - the checkout directories the case's command answers pass through,
the config file text the case writes verbatim, the source doubles the case
binds over the plane's own. Naming those paths on the standing would hand the
build's internals to every caller, and the one case-facing seam keeps them
inside the module. The refusal the depth rule names is recorded here rather
than made.

## The one external key the default Ticket carries

The default Ticket is one identity, `github:github.com:I_9`, and its external
key is the number that identity carries: `#9`. Both fact builders take the
key from the identity through one shared reading, the fetched-ticket builder
and the ticket builder alike, so a builder that stood the key on a copy of
its own would stand a key no other reader of the builders would build. The
branch the naming rule reads off that key is `factory/9-persist-source-facts`,
and the pins in the suites that read it stand on that branch: the plane's
own standing writes the default Ticket on its own key, and the plane's suite
reads the branch the naming rule derives from the row the standing wrote.

The title stands beside the key on the same one-copy rule: the static check
refuses the default Ticket's title text anywhere in the frame suites, a pin's
quoted word among it, and the frame suites compose their pins from the fact
module's one copy of the title. The sample's other ticket, the one whose
title carries the default's words before more of its own, keeps its own
title beside it: the rule takes the title as one word, not as a run of
letters.

## The flat axis the plane settles

The state module's own rule opens a fresh state file grouped by repository
(ADR 0066), and the frames in the suite assert the unsplit list. The plane
therefore writes the flat axis on every state file it opens itself, whether
or not the standing names sources, and takes a split axis as a named field: a
case that wants the split names it in one word. A standing that wraps a state
file the case opened names the axis the plane writes on that state; where it
names none, the state keeps the axis its own file holds. The plane's own suite
reads the rule back through the state module: the fresh files it opens answer
the flat axis, the wrapped state keeps its own axis, and the named field stands
on both. ADR 0131 records the rule and its override of ADR 0066's fresh-file
split.

## The deviation the spec does not hold

The spec says no case reads wall-clock time. The plane does not hold that by
its interface: where a case names no clock, the plane's clock stands on
`Date.now`, and the state file it opens stands on the same clock. The suites
hold the sentence themselves: the frame suites open their plane on the clock
the frame harness pins, the plane's own suite names its clock at boot, and
no case that depends on a time reads the wall. The wall-clock default stands
for the scratch boots that name nothing, and a case that omits the clock and
then asserts on a time would read real time. The default could be refused at
the interface instead of at review, and the refusal is recorded here rather
than made.

The same discipline stands at the Ticket source double: where the plane's
source settlement is `auto`, the double settles a read by restamping the
outcome's `fetchedAt` on the clock the plane owns, so a settle never carries
a stamp the state's own clock would call older. The poll interval is one
number end to end: the plane's base config names it in seconds, the config
file the plane writes to disk carries the same resolved value, and the source
double's refresh interval stands on the same 60 seconds, so a case that
turns the interval in the config object turns it in the file with it.

## The suites that still open their own state file

The static check governs the frame suites: a file that imports the frame
harness must not call the state opener, and it does not. Outside the frame
suites, the plane does not stand, and these module suites open their own
state file through the state module's interface:

| Suite | Why it stands outside the plane |
| --- | --- |
| [test/auto-handoff-chain.test.ts](../../test/auto-handoff-chain.test.ts) | the acceptance chain across handoffs, on the state module's calls |
| [test/checkout-hold.test.ts](../../test/checkout-hold.test.ts) | the checkout hold, a state fact the plane's standing does not seed |
| [test/attempt-hold.test.ts](../../test/attempt-hold.test.ts) | the attempt hold, on the handoff module's own interface |
| [test/observation.test.ts](../../test/observation.test.ts) | the observation cycle, on the source and state facts it tests |
| [test/next-step.test.ts](../../test/next-step.test.ts) | the next-step answer, on the state module's reads |
| [test/placement-dispatch.test.ts](../../test/placement-dispatch.test.ts) | the placement dispatch, on the state and runner it tests |
| [test/record-name.test.ts](../../test/record-name.test.ts) | the record name rule, on an in-memory state |
| [test/repo-init.test.ts](../../test/repo-init.test.ts) | the repository init, on the state fact and the runner it tests |
| [test/refresh.test.ts](../../test/refresh.test.ts) | the refresh coordinator, on the source double and the state it polls |
| [test/workflow-transition.test.ts](../../test/workflow-transition.test.ts) | the workflow transition, on the state module's fire |
| [test/terminal-desync.test.ts](../../test/terminal-desync.test.ts) | the terminal desync, on the state and runner it tests |

The state aggregate suites stand outside the plane by the decision itself:
they test the state module through its per-aggregate interface, and several
need a hand-corrupted database. The top-up suite tests the policy's pure
answer and owns no state file at all.

## The per-file rig that stands beside the plane

Two frame suites keep a per-file seeded-app rig beside the plane, and the
record states what the rig stands for and what it hides:

- [test/auto-mode.test.ts](../../test/auto-mode.test.ts) seeds its state
  through its own `seed`, on its own state directory and its own clock, and
  boots the plane on that state through the plane's `existing` field with the
  suite's source doubles bound over the plane's own. The rig's `stateNow`
  option stands for the plane's `now` field: a case that pins the clock in
  the past ages the stored handoff past the startup grace, the way the plane
  would on a pinned `now`. The rig is what it is: the plane's clock and the
  state's clock stand apart there, because the state opened before the
  plane. Retiring the rig is the plane's own seeding standing moving under
  the suite, and it is not measured as done.
- [test/starting-face.test.ts](../../test/starting-face.test.ts) boots its
  plane on the plane's `now` field, the case's `stateNow` standing for the
  pinned base: one clock serves the state and the plane there, and the suite
  keeps no clock of its own.

## The temporary directories

At the head ADR 0131 measured, the suite held 119 temporary-directory
creations across 40 files. At this change's head the test tree holds 97
`mkdtemp` creations across 36 files and 68 `tmpdir` resolutions across 39
files. The plane's cleanup stands for the frame suites' directories:
the plane registers its close in the run's preload, and the preload's hook
closes every plane every test of every file opens, however the test ends.
The hold cannot live in the plane's own module scope: Bun evaluates a plain
run's modules once, and a module-scope `afterEach` there would bind to the
one file that first imports the plane, leaking every plane the other files
open. The preload's hook belongs to no file, so it holds in every file of
the run, with or without `--isolate`: the runner evaluates the preload in
each worker the isolated run starts, and in the one process the plain run
uses. The suites that open their own state file keep their own creation
beside it.

## The duplication count at each step

The Quality audit ratchets `test-dup`, the jscpd count over the test files,
and it ratchets on exact equality: a count below the baseline fails the
audit the way a count above it does, so the baseline is restated beside the
head it was measured on.

The branch split from `origin/main` before the main test-dup campaign landed
there. The branch's tree before the rework measured 263 at its own head,
beside a 271 it read off `origin/main` at the split. The rebase moved the
branch's tree onto the campaign's main, which carries the campaign's 211
measured at its own head, and the rework on the merged tree stands the count
the baseline now holds:

| Step on this branch | `test-dup` |
| --- | --- |
| `origin/main` at the split, before the campaign | 271 |
| The branch's tree before the rework | 263 |
| `origin/main` at the rebase, after the campaign | 211 |
| This branch after the rebase and the rework, measured at its head | 205 |

The count moves up and down inside a step in general: a rig lands before
the fixture it replaces is deleted, and a builder that retires leaves its
clone behind for one measurement. The final tree stands at 205, below the
211 of `origin/main` at the rebase, and the Quality audit passes it against
the baseline beside the config.

## What is not measured

- The terminal walks of the theme-inherited paint have not been re-run on this
  branch: that is the open item the shared-controls record names, and it is not
  a measurement of the plane.
- No screen-reader path: frame tests and the static check do not establish
  screen-reader support, the way the contributor instructions name.
- The plane's doubles are read against the plane's own readers in the plane's
  own suite. A recorded run of the real Ticket sources and the real herdr
  session behind them is not a measurement of this change: the plane is a test
  module, and its seam is the Command runner the double stands behind.
