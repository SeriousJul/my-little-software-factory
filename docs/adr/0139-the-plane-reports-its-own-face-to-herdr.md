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
report, on herdr's identity report protocol.

- Inside a herdr pane - the mark is a non-empty `HERDR_ENV`, whatever its
  value, the same fact the theme read takes (ADR 0024), with the pane's
  `HERDR_BIN_PATH` and `HERDR_PANE_ID` - the plane reports itself before its
  first frame: `pane report-agent` for its pane, source `factory`, agent
  `factory`, state `idle`, sequence from the wall clock. The report is sent
  ahead of herdr's first detection of the pane, so the detection reads the
  report instead of the process. That ordering is a timing race, not a
  guarantee: on the installed herdr the detector read the `bun --watch` boot
  screen as `pi` ahead of the report's landing, once per run and once per
  watch restart, and the report's wall-clock sequence closed the transient
  detection when the report landed. Losing the race costs at most that one
  transient detection at boot; the sustained flip the issue reports is
  removed either way, because the report holds the pane's agent fact for as
  long as it stands.
- When the run ends, the plane releases the report - `pane release-agent` -
  carrying the wall clock read at the end as its sequence, ahead of the boot
  report's, on every ending that closes its state, and the SIGTERM and SIGHUP
  endings, the watch restart and the plain kill, reach the release call too:
  their handler runs the teardown that calls the release, and then the process
  exits. A release without a sequence higher than the report it clears is a
  silent no-op on the installed herdr 0.9.1 (measured: a seq-less release
  after a seq-carrying report leaves the report standing), so the release
  carries the clock and a landed release clears the report at once. The
  release's sequence is the wall clock, and the wall clock is not monotonic:
  a backward step of it between the run's boot and its end can leave the
  release's sequence not ahead of the report's, and the installed herdr then
  takes the release as a no-op, so the row stands until the pane is reused,
  closed, or the herdr session restarts. A forward step costs nothing: the
  release only needs to stand ahead of its own report. The plane takes the
  wall clock, and takes the step's risk, because the report must also stand
  ahead of herdr's own reading of the boot screen, which is made in that same
  clock. The exit
  can come before the release's command is guaranteed to land, so a signal or
  kill ending, and the `kill -9` and crash endings that run no handler, can
  leave the report standing; on herdr 0.9.1 herdr clears no report of its own
  once the pane is back at its shell prompt (measured: the report stood at the
  idle prompt for two minutes, including after pane activity), so an unlanded
  release leaves the row until the pane is reused, closed, or the herdr
  session restarts. That auto-clear is documented only on the newer
  `add-herdr-support` integration page, which the v0.9.1 tree does not hold
  (the docs index is 0.9.5). The restarted process re-reports at its boot,
  which keeps the row honest across a watch restart.
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
  own. A herdr pane with a partial environment - the mark set, the binary or
  the pane id absent - stands inert beside the old face and leaves one line
  in the run's record naming the variables the environment is missing, so a
  misconfigured herdr is visible there instead of silent.

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
- An identity report carrying a working state derived from the app's seat count.
  The seat count stands inside the app shell, and its boot record admits
  neither the callback the shell would push nor any other slot: the record's
  own check refuses the growth. Re-deriving the count beside the shell makes
  the two counts drift about the same panes. The idle report is the honest
  statement of the plane's pane, and the agents it drives already carry the
  working states the panel is for.

## Consequences

- The plane's pane stands in herdr's agent panel as one stable `factory`
  entry for as long as the run stands, and a landed release at the run's end
  clears the row at once. The row is the plane's own and is named what it is.
  An ending whose release does not land - a `kill -9` or crash, or a signal
  or kill that races the exit - leaves the row standing on herdr 0.9.1 until
  the pane is reused, closed, or the herdr session restarts, because herdr
  0.9.1 clears no report of its own at the shell prompt (measured). An
  operator who wants no row runs the plane outside herdr, where it stands
  inert, or closes the panel's sort; the plane owns no setting for the row.
- `herdr agent list` and the waits over it see the plane as an agent beside
  the pi sessions. That is the pane's truth, not a pi session: a script that
  waits on the pi agents of a workspace waits on the plane only if it names
  it. The plane's own reader of the list is the live checkout safety walk,
  whose bare-agent count would count the plane's standing row as a conflict
  with the plane itself when the plane runs in the checkout a Consultation
  inspects. The walk skips the pane the plane runs in, which it knows from
  the herdr environment, and the ticket and Consultation walks key on the
  panes they recorded, which the plane's row carries none of, so the standing
  row asks the operator to confirm nothing.
- A herdr without the identity report protocol refuses the report as an unknown
  command, and the plane degrades to its old face: the pane is misnamed as
  before, and nothing else of the run changes. A herdr with it keeps the pane
  named `factory` across the screen changes and the watch restarts.
- The field state, measured on this machine, herdr 0.9.1, in an isolated
  named session (own socket and state dir; the operator's live session was
  never touched, and every session was stopped and deleted after). Two
  measurements stood in it. The first drove the report the way the plane
  drives it - the same `report-agent` and `release-agent` calls through the
  herdr binary - against a herdr-managed shell pane whose process detection
  is empty, the pane standing in for the `bun --watch` process. The pane
  stood in `herdr agent list` and `pane get` as `agent: factory, idle` in
  place of that empty detection, and held that face across a simulated watch
  restart: the old run reported a lower sequence and died, the restarted run
  reported a higher one, and a late seq-less release or a late lower-sequence
  release from the dead old run was ignored while the restarted run's report
  stood; a release carrying a sequence higher than the run's last report
  cleared the row at once.
  The second ran the real dev entry, `bun --watch src/factory.ts`, in two
  panes of one workspace: the pre-fix tree in one pane and the post-fix tree
  in the other, both against an isolated factory world with no ticket
  sources, so the plane drove no agent while it rendered the real screens.
  Herdr's detector misread the process in both panes: it named the
  `bun --watch` process `pi` on the run's boot screen and on a watch
  restart's, and its reading of the pane flipped between `Some(Pi)` and
  `None` as the plane's screen state changed from boot screen to steady
  view. In the pre-fix pane no report stands, so the detector's reading is
  the pane's agent fact: the fact flipped `pi` to `None` and back with the
  screen states, and the row named `pi` appeared in `herdr agent list` on
  the boot screen, stood for the read herdr made before its next, and left
  with the flip to `None` - the row the client's agent panel gains and loses
  on every flip, the reflow a watched neighbour pane reads as a scroll that
  runs back and forth. In the post-fix pane the report stood over that
  conflicting detection: the detector kept recording its raw flips of the
  misread process in the server log, but the pane's agent fact - what `pane
  get`, `herdr agent list`, and the client's panel read - stood `agent:
  factory, idle` at every sample across the flips, across seven watch
  restarts (every restarted run re-reporting with a wall-clock sequence
  ahead of the old run's), and across the overlay, section, and refresh
  screen states; no `agent list` sample of the fourteen-minute window
  returned a row other than `factory` for the pane. On each restart the
  detector read the boot screen as `pi` a fraction of a second ahead of the
  restarted run's report landing, and the re-report closed the transient when
  it landed. The run's SIGTERM ending called the release, it landed, and it
  cleared the row at once on the real process. The neighbour pi tab standing
  still on the settle of a turn is the operator's live-session observation
  of the reflow that flip removal takes away; these sessions measured the
  flip removal on the plane's own pane against the process herdr names `pi`,
  and the operator confirms the tab itself on their machine.
- The plane calls the herdr binary at its boot and at its end, both through
  the shared command runner. The clean ending calls it once at the boot and
  once in the exit hook. The SIGTERM and SIGHUP endings call it in the handler
  and again in the exit hook that follows the exit, so the end can cost two
  calls, and the process can leave a call in the air. The suite's fake runner
  sees the calls, and a suite that renders the plane outside herdr sees none.
