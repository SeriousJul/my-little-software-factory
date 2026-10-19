# ADR 0139: The plane reports its own face to herdr

Status: accepted
Date: 2026-10-19

Records that the control plane, when it runs in a herdr pane, reports itself to
herdr as the `factory` agent of its own pane and releases that report when the
run ends, that it stands inert outside herdr, and that the report is the plane's
answer to herdr's misread of its pane as a pi agent (issue #405). It moves no
control, changes no key, and grows no interface the App shell's boot record
refuses to grow.

## Context

Herdr identifies each pane's foreground process from the process's shape and
the screen it draws: a detection manifest names the agent from the process,
and rules over the screen's bottom read its state. A process herdr names as an
agent but whose screen matches no rule reads `idle` by a documented fallback,
and the name stands while the process stands.

The plane's dev run is `bun --watch src/factory.ts`, and the operator keeps it
in a tab beside the pi sessions it drives, in the same herdr workspace. On the
reporting machine the herdr server's own log records the plane's pane flipping:
`agent changed pane=48 previous_agent=None agent=Some(Pi) process=pi` for a
`bun --watch` process whose environment holds no agent marker at all,
alternating with `agent=None`, on the order of a flip every half minute, and
again at every watch restart. Asked to explain the misread pane, the running
herdr answers `agent: pi`, `rule: none`, fallback
`default_known_agent_idle_fallback`: the process is named pi by herdr's own
detection, the screen matches nothing, and the idle stands. The pane's screen
changes with the plane's life: the five-second observation repaints, the boot
screen of a watch restart, and the state the run stands in when a turn it
drives settles. Every such change gives herdr a fresh read of a pane it is
already unsure about, and the flip lands on it.

Each flip re-renders the herdr client that shows the workspace: the agent
panel gains or loses a row named after the plane's pane, the workspace rollup
glyph changes with it, and the client lays out its viewport again. A pi
session the operator watches in a neighbour tab rewraps its visible
conversation on every re-layout. The operator reads the pair of renderings as
the session's screen scrolling back and forth. The reading lands on the settle
of a turn, because the settle is the moment the plane's own screen changes
state and the misread flips with it, while the operator's eye is on the pi
tab.

A reproduction held the plane in one workspace tab, a pi Consultation in the
neighbour tab, and a herdr client in a pane the investigator could read. The
client's screen alternated between exactly two renderings while the plane's
pane was misnamed - an agent panel row for the plane's pane under the name
`pi`, and one without - and stood still before and after. The flip's window
matched herdr's log of the pane gaining and losing the `pi` name, to the
second.

## Decision

The plane gives herdr the one identity herdr cannot misread: the process's own
report, on herdr's self-report protocol.

- Inside a herdr pane - `HERDR_ENV` set to `1` with the pane's
  `HERDR_BIN_PATH` and `HERDR_PANE_ID` - the plane reports itself before its
  first frame: `pane report-agent` for its pane, source `factory`, agent
  `factory`, state `idle`, sequence from the wall clock. The report lands
  ahead of herdr's first detection of the pane, so the detection reads the
  report instead of the process.
- When the run ends, the plane releases the report - `pane release-agent` -
  on every ending that closes its state, and the SIGTERM and SIGHUP endings,
  the watch restart and the plain kill, reach the release call too: their
  handler runs the teardown that calls the release, and then the process
  exits. The exit comes before the release's command is guaranteed to land,
  so a killed run can leave the report standing; herdr clears a report of its
  own once the pane is back at its shell prompt, and the restarted process
  reports again at its boot, so the gap closes without the plane's help. The
  `kill -9` and crash endings run no handler at all and rest on the same
  herdr clearing.
- The reported state is `idle`, and only `idle`: the plane's pane waits on
  the operator and runs no turn of its own, and the agents the plane drives
  report their own states in their own panes. No working state is reported:
  the plane's busyness is the shared seat count the observation cycle and the
  dispatch gates read (ADR 0034), and a second derivation of it in a
  process-level module would be a second seat count, which the plane does not
  keep.
- The report and the release go through the plane's one command runner with a
  five-second budget, fire and forget: a refused or slow report is a line in
  the run's record, and it degrades the plane to the face herdr always gave
  it. It never holds the boot or the shutdown, and it never fails the run.
- Outside herdr the module stands inert: there is no herdr there to misread
  the plane's face, and the plane makes no call to a herdr binary it does not
  own.

## Considered options

- Waiting on a herdr fix to its pi detection of a `bun --watch` process. The
  installed herdr is a closed binary of another project, and its detection
  rules are retuned by remote manifest updates the plane cannot time. The
  plane's face cannot rest on another program's screen heuristics, and the
  operator's machine runs the misreading version until its own update.
- Shaping the plane's process or screen until the pi detection stops matching
  it. The match is a heuristic over the process and the screen, and the plane
  cannot know the next retuning of it. Shaping the run to dodge a heuristic
  trades one flip for the next; stating the truth dodges none of them, because
  there is nothing left to misread.
- A self-report carrying a working state derived from the app's seat count.
  The seat count stands inside the app shell, and its boot record admits
  neither the callback the shell would push nor any other slot: the record's
  own check refuses the growth. Re-deriving the count beside the shell makes
  the two counts drift about the same panes. The idle report is the honest
  statement of the plane's pane, and the agents it drives already carry the
  working states the panel is for.

## Consequences

- The plane's pane stands in herdr's agent panel as one stable `factory`
  entry for as long as the run stands, and leaves it when the run ends. The
  row is the plane's own and is named what it is. An operator who wants no
  row runs the plane outside herdr, where it stands inert, or closes the
  panel's sort; the plane owns no setting for the row.
- `herdr agent list` and the waits over it see the plane as an agent beside
  the pi sessions. That is the pane's truth, not a pi session: a script that
  waits on the pi agents of a workspace waits on the plane only if it names
  it.
- A herdr without the self-report protocol refuses the report as an unknown
  command, and the plane degrades to its old face: the pane is misnamed as
  before, and nothing else of the run changes. A herdr with it keeps the pane
  named `factory` across the screen changes and the watch restarts.
- The plane calls the herdr binary at its boot and at its end, both through
  the shared command runner. The clean ending calls it once at the boot and
  once in the exit hook. The SIGTERM and SIGHUP endings call it in the handler
  and again in the exit hook that follows the exit, so the end can cost two
  calls, and the process can leave a call in the air. The suite's fake runner
  sees the calls, and a suite that renders the plane outside herdr sees none.
