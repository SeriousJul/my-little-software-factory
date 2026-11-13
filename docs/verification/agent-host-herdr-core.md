# The Agent host verification

Status: **the decision records stand, and steps 1 through 5 of the change are
in the tree.** ADR 0141, ADR 0142, ADR 0143, and ADR 0144 and the glossary's
**Agent host**, **Host resolution**, and **Adoption label** entries landed on
2026-11-12, and the first step of the change landed beside them (pull request
#414): one module (`src/agent-host.ts`) owns both Agent host dialects, the host
word map, and the host resolution - the config, then the environment mark,
then the default - as a tested function beside its marks; the Stub herdr world
answers the herdr-core dialect beside herdr and git, its closed-surface rule
walking the host dialects the module builds, and the check that refuses a
`herdr` or `hc` argument outside the module stands. Step 2 (issue #408) landed
on the same branch: the config takes the `agent-host` key and the
`[agent-host.herdr-core]` table, the boot resolves the host once - the
operator's key first, then the environment mark it reads once, then the
default - and states the host and the fact that resolved it on the Message
line and in the Plane boot record, and a herdr-core host below 0.1.20 wears
one Warning line at the boot from its own version read, the one host command
the boot runs. Step 3 (issue #409) landed on the same branch (pull request
#416): the Consultation launcher and the override panel carry the Agent host
row beside their other rows, built on the shared control library; the Handoff
records the start's final host beside its handles, in its own column of the
handoff and Consultation tables (schema V31, no migration guess: the old rows
take `herdr`, the only host their runs resolved); the Handoff detail and the
Work queue name the host beside the handles; a Restart repeats the recorded
host's dialect - the seam test runs it on a run that resolves the other host
- and the automatic routes, the top-up's open add, the route, and the queue
pickup, take the run's resolved host and never the per-handoff record; on a
herdr-core run the herdr host is unreachable, and the launcher's Launch row,
the panel's row, the start's pre-flight, and the Key guide all state the one
line that names the host and the reason. Step 4 (issue #410) lands beside
them: the observation poll reads both hosts and merges them into one Agent
list, and every reader of the list - the Top-up walk, the Parallel limit's
seat count, the row's failure badge, the Missing agent marker, the Startup
grace window, and the Consultation operations - takes the merged list
unchanged; the one name holds one live Agent across both hosts, the live-name
check runs over the merged list, and the collision record names the host that
holds the name; the Parallel limit counts its seats over the merged list; and
every herdr-core terminal the plane starts carries its run labels and the
Adoption labels its own terminal carries, written at the start and never
rewritten. Step 5 (issue #411) lands beside them: on the herdr-core host the
plane runs git itself for the worktree, the branch, and the removal, and the
Agent still never starts outside a host; one checkout per Ticket stands across
both hosts in herdr's own directory, the naming rule herdr 0.9.5 answers and
the plane now states as a contract; the reopen lookups read git's
`worktree list --porcelain` record on both hosts, whose record holds both
hosts' worktrees, and herdr's extra facts are read only where a herdr
workspace has to come down with the checkout; each host's cleanup stays on its
own side - the herdr-core close kills and removes the terminal with `hc` and
removes the checkout with git, and it never removes a checkout a herdr
workspace still holds; the Leftover worktree directory moves aside on both
hosts; the herdr host keeps its herdr commands, the `worktree create` and
the `worktree remove --workspace`, which run as before, but its reopen
lookup now reads git's record instead of herdr's list, and a git list that
does not read degrades the start to the fresh `worktree create` instead of
failing it, where a raise of the herdr list used to fail the start, and the
Close keeps the fail-closed read of herdr's list. Step 6 (issue #412) lands
beside them: on the herdr-core host the plane derives the Agent session record
path in the per-kind table that stands beside the Agent type's other per-kind
knowledge, where pi stands and no other kind does (ADR 0144); a settle whose
host names no record reads the derived path through the same per-kind reader
the herdr path reads, a host that names its record is never overruled, and a
derivation that answers unavailable - two candidates that both fit, an unreadable
session home, or a kind with no derivation - settles on the terminal capture
with the fail-open `unknown` cause and the settle's one line on the Message
record, never a failure of the turn and never `no-turn`; the derivation is one
directory read of one session home, the plane writes nothing into a runtime's
session home, and it stands only for an Agent that runs on the plane's own
machine. What has not run is the same boundary it was before, and it stands
below: no plane command has ever gone to a real herdr-core host, and the
herdr-core facts the plane reads on that host are the probe answers above,
not a live run. A check that could not run is recorded as incomplete; it is
not a pass.

See [ADR 0141](../adr/0141-the-plane-resolves-its-agent-host-herdr-or-herdr-core.md),
[ADR 0142](../adr/0142-one-run-holds-agents-on-both-hosts-and-the-host-stands-on-the-handoff.md),
[ADR 0143](../adr/0143-on-the-herdr-core-host-the-plane-owns-the-worktree-lifecycle.md), and
[ADR 0144](../adr/0144-on-the-herdr-core-host-the-plane-derives-the-agent-session-record-path.md)
for the decisions, and
[the Stub herdr world verification](./stub-herdr-world.md) for the answer-shape
rule this file follows.

## Machine state of the probes

`herdr` 0.9.5 (`herdr server`, protocol 22) and `herdr-core` (`hc`) 0.1.20,
installed as system packages; `git` 2.56.0; `bun` 1.4.2; `pi` 1.5.2; Linux 7.2.15
(Omarchy). Probes ran on 2026-11-12.

**Method, and the cleanup that goes with it.** Every herdr-core probe ran in a
scratch session: `HC_SESSION=factoryprobe`, `HC_SOCKET` and `XDG_RUNTIME_DIR`
pointed under `/tmp`, so the probe core was a separate process on a separate
socket from the operator's own `herdr-core serve`. Every probe terminal was
killed and removed and every probe core was stopped (`hc server stop` answered
`{"stopped":true}`), the leftover probe core was killed by pid after confirming
its `HC_SESSION`, and the scratch directories were deleted. The operator's own
core and its holder were never sent a command. The herdr probes were read-only
(`herdr status`, `herdr worktree list`). No window manager or desktop tool ran,
and no test touched the desktop environment. The rework's live-kill line ran
the same method on the same day, in its own scratch session.

## The herdr-core answer shapes the plane will read, traced

Recorded from the probe commands themselves, not from `hc --help`, so each row
is the answer a caller gets.

| Ask | Recorded answer |
| --- | --- |
| `hc server status` with no core on the session | `{"core":{"id":"dcb6…","name":"seriousarch"},"holder":null,"holders":[],"live":0,"pid":951931,"uptime_ms":8,"version":"0.1.20"}`: the status read **started the core**. No Unix read answers without starting one, so the plane states the effect instead of pre-checking it (ADR 0141) |
| `hc ls --json` | `{"hidden_finished":0,"terminals":[{"address":"t1","agent":"sh","cwd":"…","name":"probe-a","state":"live","turn":0}]}`: the roster carries **no status word** |
| `hc get <t> --json` | the full record: `address, argv, cols, rows, cwd, die_with_parent, exit_code, finished_ms, foreground, identity, keep, labels, name, notify, parent, pid, reason, reported, rm, screen, signal, state, status, status_ms, template, title, turn` |
| `hc run --bg --outlive-parent --no-notify --name probe-a --label factory.run=probe --label factory.ticket=t-1 -- sh -c …` | `{"address":"t1","agent":"sh","cwd":"…","name":"probe-a","state":"live","turn":0}`, and the later `get` shows `die_with_parent: false`, `notify: false`, `keep: false`, `rm: false`, `labels: {"factory.run":"probe","factory.ticket":"t-1"}`: the flags ADR 0141 fixes land on the record |
| `hc send --json <t> <text>` | `{"started":null,"status":null,"turn":0}`: `started` is null for a program that reports no status, so the plane reads "the text went in" and not "the turn started" |
| `hc send --json --if idle <t> <text>` on a finished terminal | `{"error":{"kind":"finished","message":"t1 has finished","hint":"hc read t1"}}` |
| `hc read --lines 5 --json <t>` | `{"complete":true,"how":"history","text":"hello-plane\nGOT:hello-plane"}`. Herdr-core's manual adds the rule the plane needs: with the program in `working`, `blocked`, or `error` state a history read returns the **screen only**, marked incomplete with `why` set to that state, and no scroll input is sent |
| `hc wait --timeout 5 --json <t>` | `{"children":[],"ended":true,"exit_code":0,"reason":"exit","signal":null,"status":null,"terminal":"t1","turn":0}`: `reason: exit` with an `exit_code` is the answer for a program that ended rather than a turn that settled |
| `hc ls --label factory.ticket=t-1 --json` | `{"hidden_finished":1,"terminals":[]}`: a label-scoped roster **still hides finished terminals**, so a Missing agent or Leftover environment read must ask for `--all` |
| `hc kill --json <t>` of a finished terminal, then `hc rm <t>` | the record again with `state: "finished"`, `reason: "exited"`, `exit_code: 0`, then `{"removed":"t1"}`: the probe's program had finished before its kill ran |
| `hc kill --json <t>` of a live terminal (`sleep 30` in the rework's scratch session) | the record with `state: "finished"`, `reason: "killed"`, `signal: 1`, `exit_code: null` |
| `hc ls --all --json` | a finished terminal stays listed with `reason: "exited"` and its `exit_code` until `hc rm`, so a started-then-dead Agent stays readable |
| A taken or unusable name | `{"error":{"kind":"name_taken",…}}` for a live name, and `{"kind":"invalid_params","message":"bad name \"probeA\": use 1-32 of a-z 0-9 - _ . starting with a letter or digit, not shaped like an id (t7)"}` for a bad one. The `hc schema` read on 0.1.20 holds no `usage` kind: its `terminal.*` kinds are `invalid_params`, `name_taken`, `not_found`, `finished`, `blocked`, `status_mismatch`, `spawn_failed`, `live`, `machine_unknown`, `unavailable`, `config`, and `cancelled`, beside the machine and doc kinds. The probes met `name_taken`, `invalid_params`, and `finished` directly; the rest stand from the schema read, `live` first - the kind the Stub world's `rm` refusal and the word table stand on |
| The plane's own names against that rule | Derived, not run: every name `src/naming.ts` builds carries a leading word and a fixed 8-hex identity tag (`agentNameFor`, `cycleAgentName`, `consultationAgentName`), so none takes the refused `t<digits>` shape and none uses a character outside hc's set. The naming suite's check that it stays that way is an **open item** below, not a measured pass |

## The other measured facts

- **herdr's worktree layout**, read from `git worktree list` on the source
  checkout and from `herdr worktree list --cwd` on 2026-11-12: herdr's worktrees
  stand in `<home>/.herdr/worktrees/<repo name>/<branch with each slash for a
  hyphen>`, git already records every one of them at those paths and branches,
  and herdr's list answer is git's shape with `open_workspace_id` and
  `source_workspace_id` beside it. ADR 0143's path rule rests on this row, and
  step 5 makes it the plane-stated contract: the plane builds a herdr-core
  checkout at that same path for the branch, and a herdr that changes the
  naming is a measured break against this row.
- **herdr's list answers from the checkout's git record**: `herdr worktree
  list --cwd <linked worktree path>` answers the same list as it does from the
  source checkout, so the plane reads herdr's extra facts next to the
  checkout the close has to take down, and git's record holds both hosts'
  worktrees for the reopen lookups.
- **The git shapes the plane reads on the herdr-core host**, probed 2026-11-13
  on this machine's git 2.56.0 against a scratch clone: `git worktree list
  --porcelain` answers blank-line blocks of `worktree <path>`, `HEAD <sha>`,
  and `branch refs/heads/<b>`, and a record git prunes carries a line whose
  first word is `prunable` (`prunable gitdir file points to non-existent
  location` on 2.56.0). The refusals: an add over a path that already stands
  answers `fatal: '<path>' already exists` with exit 128, and the add's branch
  stands behind the refusal; the same add over a stale record with the path
  standing answers `fatal: '<path>' is a missing but already registered
  worktree; use 'add -f' to override, or 'prune' or 'remove' to clear` with
  exit 128, the record surviving; an add onto a branch that already exists
  answers `fatal: a branch named '<b>' already exists` with exit 255; a remove
  of a dirty checkout answers `fatal: '<path>' contains modified or untracked
  files, use --force to delete it` with exit 128; a remove of a path git no
  longer records answers `fatal: '<path>' is not a working tree` with exit
  128, which the plane reads as the already-clean close; and `git worktree
  remove` and `git worktree prune` of a stale record answer silently, the
  record cleared. The Stub world's git side answers these shapes.
- **herdr-core's terminal size**: a start from a non-terminal gets `200x120`, and
  the child program receives `HC_TERMINAL_ID` (a probe printed its own address and
  `stty size` as `120 200`).
- **The version read the boot runs**: `hc --version` in an isolated session
  (2026-11-12, this machine) answered `hc 0.1.20` with exit 0 and left the
  session's runtime directory empty - the read answers from the binary and
  starts no core, the measurement ADR 0141's no-lifecycle rule rests on. The
  boot's floor check runs this same probe, and an older host states the
  Warning line beside it.
- **The poll cost, re-measured over the merged read (issue #410)**: the merged
  poll is one roster read per host plus one `hc get` per herdr-core Agent the
  plane holds, because the core roster carries no status word. Counted from
  the command set the frame's tests stand on:
  - a **herdr run** poll is `herdr agent list` plus `hc ls --json --all` plus
    one `hc get` per held herdr-core terminal: **two commands per poll** when
    the plane holds no core terminal, three at the shipped
    `max-parallel-agents = 2` holding one core Agent and one herdr Agent.
    Before step 4 the herdr run's poll was herdr's one command, and this is
    the cost the step adds to it.
  - a **herdr-core run** poll is `hc ls --json --all` plus one `hc get` per
    held terminal: **three commands per poll** at the shipped cap, the same
    count ADR 0142 stated, one when the plane holds no terminal.
  - **the start's cross-host read** adds one roster read of the other host to
    each start: a herdr start runs `hc ls --json`, a herdr-core start on a
    herdr run runs `herdr agent list`, and a herdr-core start on a herdr-core
    run reads nothing on the other host, because the host is unreachable from
    the run there.
  The count stands from the command sequences the named suites assert, not
  from a timer: no latency measurement of the merged poll has run, and none
  is claimed.
- **The name rules agree**: hc's set is `a-z 0-9 - _ .` to 32 characters with the
  id-shape clause; herdr's is `[a-z][a-z0-9_-]{0,31}`, which `src/naming.ts`
  already honours through `HERDR_NAME_MAX_LENGTH`. hc accepts a dot herdr refuses;
  the plane's names use neither.
- **The status words are the same five** (`idle`, `working`, `done`, `blocked`,
  `error`) on both hosts, because both read the program's OSC 7501 reports. My
  probe's hand-written 7501 record was refused by the host and registered
  nothing, so the plane's own mapping of those five words is **unmeasured**: no
  real agent ran under herdr-core in these probes.
- **The pi session home the derivation reads**, measured 2026-11-13 on this
  machine's pi 1.5.2 against one real pi session that ran in this worktree:
  the session home stands at `<home>/.pi/agent/sessions`; the per-checkout
  directory is the checkout path with each of `/`, `\`, and `:` replaced by a
  dash and wrapped in a leading and a trailing dash - for this ticket's
  checkout, `--home-seriousjul-.herdr-worktrees-my-little-software-factory-factory-412-the-derived-agent-session-record-path-on-the-herdr-core-host--`;
  and a session record stands in that directory named
  `<YYYY-MM-DDTHH-MM-SS-mmmZ>_<uuid>.jsonl`, its first line a
  `{"type":"session"}` header carrying the record's `id`, its `cwd` (the
  checkout), and the `timestamp` the record began. The derivation's test
  reproduces these facts on a fixture home, so no test reads the operator's
  session home. What the measurement covers: the session home's place, the
  checkout's directory name, the record's file name, and that header, as pi
  1.5.2 writes them on this machine. What it does not cover: a session a
  herdr-core-launched Agent opens, a settle on a real herdr-core host, and any
  runtime but pi.

## What has not run

The plane's side of this design has run in the suite against the Stub herdr
world since step 3 (issue #409): the start's dialect, the prompt, the Close
and the residue cleanup, the Restart seam that repeats the recorded host's
dialect, and the launcher, panel, and Key guide frames per host all stand in
the suites named in the table below, beside the shared controls' own suites.
What has not run is the same boundary it was before, and
it stands below, each one owed by the change that lands it:

- No plane command has ever gone to a real herdr-core host: no start, prompt,
  roster, wait, read, kill, or removal, and no worktree, branch, or checkout
  command of the plane's own git, and no merged Observation cycle over a real
  herdr-core roster. Every herdr-core command the plane runs in the suite runs
  against the Stub herdr world, and the version read the boot runs is the one
  host command a real boot sends, a read that starts no core.
- The settle that reads a record a herdr-core-launched Agent wrote on a real
  host: the derivation of ADR 0144 and its ambiguous-match answer run in the
  suite on fixture session homes, one of them standing in for the real pi
  session measured above, but no settle on this host has read a record a
  herdr-core-launched Agent opened, and no runtime but pi has stood on the
  derivation at all.
- The Adoption labels of ADR 0141: the Herdr desktop was not running during
  the probes, so no terminal was ever seen in a desktop window through those
  labels. The adoption rule itself is quoted from the desktop app's own
  generated instructions, and the walk is unverified.
- The naming-suite check that keeps the plane's names inside herdr-core's
  refused id shape (the derived row above).
- Two runs of the plane on one machine sharing one herdr-core session: never
  attempted, so the cross-process name-collision case ADR 0142 leans on stands
  unverified.
- The screen-reader path stays unverified for both hosts, exactly as
  [the shared-controls verification record](./shared-controls.md) states, and
  the terminal walks on the theme-inherited paint stay open there. This change
  makes no accessibility claim.

## What step 6 stands on, in the suite

Step 6's behaviors run in these suites; one entry per behavior, each beside
the behavior's home module. The session homes they read are fixtures, and the
one measurement suite stands in for the operator's session home with the facts
measured above.

| Behavior the step lands | Where it stands in the suite |
| --- | --- |
| The per-kind table: pi stands with its layout, and a kind outside the table answers `no-derivation`, the unavailable lookup the plane carries for frame tests answering it for every kind | `test/session-record.test.ts`, the per-kind table suite |
| The pi layout: the checkout directory under dashes, the record name's stamp - a name without a millisecond stands for the whole second, a name with no stamp is not followed, and a stamp that is not a time says none - and the `{"type":"session"}` header's words for the checkout and the start | `test/session-record.test.ts`, the layout suite |
| The lookup in the open: the record the runtime began for the run is named, and a record that began before the run, a record of another checkout, a name the stamp cannot read, and a header that is not a session all name no path; a home without the checkout's directory, and a session place that is a file, answer `no-home`; a run without a checkout, and a start time that is not a time, answer `no-checkout` and `no-start` | `test/session-record.test.ts`, the derivation suite |
| The ambiguous match, a first-class answer: two candidate records that both fit refuse the path and answer `ambiguous` | `test/session-record.test.ts`, the derivation suite |
| The ticket settle seam: an available derived path reads through the same per-kind reader the herdr path reads with the run's start time, the pane stays unread, and the turn settles beside the record's log; an unavailable derivation takes the capture, settles the turn with the fail-open `unknown` cause and the settle's one line on the Message line, asks no reader, and never settles `no-turn`; a herdr-host settle keeps its host-reported record and never asks the lookup | `test/observation.test.ts`, the herdr-core settle tests |
| The Consultation seam: a herdr-core Consultation settles its turn on the derived record beside the visible screen, and a derivation that answers unavailable settles on the recent scroll capture with the fail-open cause | `test/observation.test.ts`, the Consultation settle tests |
| The real-runtime measurement: the measured pi session's facts - the checkout's directory name, the record's file name, and its header - stand on a fixture home, and the derivation names the record | `test/session-record.test.ts`, the measurement suite |

## What step 5 stands on, in the suite

Step 5's behaviors run against the Stub herdr world in these suites; one entry
per behavior, each beside the behavior's home module. The git answers they read
are the shapes above, standing in the Stub world's git side.

| Behavior the step lands | Where it stands in the suite |
| --- | --- |
| One checkout per Ticket across hosts: the herdr-core start builds the checkout at `<home>/.herdr/worktrees/<repo name>/<branch with each slash for a hyphen>` with `git worktree add`, and the plane owns no second worktrees directory | `test/handoff.test.ts`, the herdr-core start's command pins, and `test/herdr-world.test.ts`, the git shape pins |
| A host switch inside one Ticket cycle reopens the same checkout on the same branch, and one pull request stands for it | `test/handoff-dispatch.test.ts`, the host-switch reopen test |
| The reopen lookups answer from git's record on both hosts: a worktree herdr made and a worktree the plane made are both found, a stale git record meets the same path lookup, and a worktree that stands on disk under an unregistered path still refuses the add | `test/handoff.test.ts`, the reopen lookup tests on both hosts, and `test/herdr-world.test.ts` |
| The herdr host's start degrades a git list that does not read: a refusal or a raise records the start as unreadable, and the start proceeds to the fresh `worktree create`, with no path reopen and no leftover move-aside; a raise of the list no longer fails the start the way a raise of herdr's list did | `test/handoff.test.ts`, the herdr-host start whose worktree list does not read |
| The residue contract: a start removes only what it made, on each host, and the herdr-core start's failure removes its checkout with git and its own new branch beside it | `test/handoff.test.ts`, the herdr-core start's residue test, and the herdr-host start's residue tests |
| The Close cleanup on herdr-core never issues a git removal of a checkout a herdr workspace still holds: a close from a herdr host that reads a herdr workspace on the checkout stands with the reason and no removal, a close whose herdr list does not read fails the close and keeps the checkout, and a close from a herdr-core host issues no herdr command and removes the checkout with git | `test/handoff.test.ts`, the herdr-core Close's guard tests |
| The Leftover worktree directory moves aside on both hosts: the refused add leaves its branch standing, the directory moves under a name that says what it is, and the retry checks the branch out without naming it again, never deleting | `test/handoff.test.ts`, the leftover tests on both hosts |

## What step 4 stands on, in the suite

Step 4's behaviors run against the Stub herdr world in these suites; one entry
per behavior, each beside the behavior's home module. Every herdr-core answer
they read is the Stub world's standing for the probe answers above.

| Behavior the step lands | Where it stands in the suite |
| --- | --- |
| The merged list is one list with a host fact: a herdr run reads both hosts into it, the per-Agent read is bounded to the terminals the plane holds, a core half failure stands beside the herdr half, and a herdr half failure drops the list; a herdr-core run reads its own host only | `test/observation.test.ts`, the `MergedAgentReader` suite |
| The readers take the merged list unchanged: the Startup grace window and the Missing marker read per host record, and a lost herdr-core terminal beside a live handoff reads as Missing | `test/observation.test.ts`, the missing-agents suite |
| The Parallel limit's seat count over the merged list: a herdr-core terminal holds the seat the herdr pane holds, a started herdr-core Agent holds inside its startup grace, and the one count sums both hosts' Agents | `test/parallel.test.ts`, the merged-list seat suite |
| The wake-wait mapping: `hc wait`'s `reason: exit` beside an `exit_code` reads as the settle fact herdr's `done` is, and nothing else - no code, `ended: false`, a killed reason, a failed command, or unreadable output - matches | `test/observation.test.ts`, the merged reader's wait suite, and `test/auto-mode.test.ts`, the full loop over both hosts |
| One name across both hosts: a herdr start is refused on a name herdr-core holds and vice versa, each failure and the Ticket's standing collision record name the holding host, and the start reads the other host's roster | `test/handoff-dispatch.test.ts`, the one-name-across-both-hosts suite, and `test/handoff-frame.test.ts`, the start's command sequence |
| The labels written at the start: the run labels on the herdr-core start's `hc run`, beside the adoption labels its own terminal carries - a terminal that carries `herdr.space` and one that does not, and the standalone run identity - with the flags ADR 0141 fixes | `test/handoff-dispatch.test.ts`, the label tests of the same suite |
| The poll's command set per frame: the merged read's `herdr agent list` beside `hc ls --json --all` is the only command the observation frame runs | `test/ignored-ticket.test.ts` and `test/muted-source.test.ts`, the frame command assertions |
| The closed surface over the merged dialect: the Stub world answers `ls` with `--all` and label scopes, the per-terminal `get`, and the refusal kinds, and the argument check walks the builders the module builds | `test/herdr-world.test.ts`, the closed-surface walk, and `test/agent-host.test.ts` |

## What step 3 stands on, in the suite

The plane's herdr-core flow runs against the Stub herdr world in these suites;
one entry per behavior, each beside the behavior's home module.

| Behavior the change lands | Where it stands in the suite |
| --- | --- |
| The launcher's host row, per host: the row, its default on the run's resolved host, the replacement launcher's host from the replaced record, and the Launch row's refusal line on a host the run cannot reach | `test/consultation-launcher.test.ts`, the frame tests per host |
| The override panel's host row, per host, beside the panel's other rows; the row's one refusal line and the Key guide's statement of it on a herdr-core run | `test/override-panel.test.ts`, the frame tests per host, and `test/key-guide.test.ts`, the guide's statement of the host's line |
| The start's dialect on the recorded host: a herdr-core start issues `hc run`, `hc send`, and the terminal's handles beside them; the Handoff detail and the Work queue name the host | `test/handoff.test.ts`, the herdr-core start, Close, and residue suites |
| The Restart seam: a restart of a herdr-core handoff runs the core's dialect on a run that resolves herdr, and a restart of a herdr handoff is refused at the pre-flight on a herdr-core run, before the core's first command | `test/handoff-dispatch.test.ts`, the describe block the issue names |
| The automatic routes take the run's host, not the record's: the top-up's open add resolves the run's host beside a ticket whose last handoff recorded the other host, and the Work queue's pickup starts the run's host, never the host the ticket's handoff recorded | `test/observation.test.ts`, the open-dispatch suite, and `test/handoff-dispatch.test.ts`, the route's host block |
| The V31 migration: the handoff and Consultation tables gain one host column each, and the old rows take the host their runs resolved, stated, not guessed | `test/state/consultationRecord.test.ts`, the V30-to-V31 walk |
| The closed surface: no `herdr` or `hc` argument outside the module, and the Stub world answers the dialects the module builds | `test/agent-host.test.ts` and the closed-surface walk in `test/herdr-world.test.ts` |

## Issue and version pins

herdr-core 0.1.20 is the release every shape above was read against, and ADR 0141
makes it the floor. herdr 0.9.5 is the version of the worktree-layout row and of
the naming rule the plane states from it; ADR 0143 records the layout as a
contract with herdr's directory naming, and a herdr that changes it is a measured
break, not a silent one. git 2.56.0 is the version of the git-shape row.
