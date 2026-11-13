# The Agent host verification

Status: **the decision records stand, and steps 1, 2, and 3 of the change are in
the tree.** ADR 0141, ADR 0142, ADR 0143, and ADR 0144 and the glossary's
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
line that names the host and the reason. Everything on the plane's side of the
herdr-core dialect now runs against the Stub herdr world in the suite. What
has not run is the same thing it was before, and it stands below: no plane
command has ever gone to a real herdr-core host, and the herdr-core facts the
plane reads on that host are the probe answers above, not a live run. A check
that could not run is recorded as incomplete; it is not a pass.

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
  `source_workspace_id` beside it. ADR 0143's path rule rests on this row.
- **herdr-core's terminal size**: a start from a non-terminal gets `200x120`, and
  the child program receives `HC_TERMINAL_ID` (a probe printed its own address and
  `stty size` as `120 200`).
- **The version read the boot runs**: `hc --version` in an isolated session
  (2026-11-12, this machine) answered `hc 0.1.20` with exit 0 and left the
  session's runtime directory empty - the read answers from the binary and
  starts no core, the measurement ADR 0141's no-lifecycle rule rests on. The
  boot's floor check runs this same probe, and an older host states the
  Warning line beside it.
- **The poll cost ADR 0142 states**: one roster read plus one `hc get` per Agent,
  because the roster carries no status word. At the shipped
  `max-parallel-agents = 2` that is **three commands per poll** on that host,
  against herdr's one. Counted, not timed: no latency measurement of herdr-core
  has run, and none is claimed.
- **The name rules agree**: hc's set is `a-z 0-9 - _ .` to 32 characters with the
  id-shape clause; herdr's is `[a-z][a-z0-9_-]{0,31}`, which `src/naming.ts`
  already honours through `HERDR_NAME_MAX_LENGTH`. hc accepts a dot herdr refuses;
  the plane's names use neither.
- **The status words are the same five** (`idle`, `working`, `done`, `blocked`,
  `error`) on both hosts, because both read the program's OSC 7501 reports. My
  probe's hand-written 7501 record was refused by the host and registered
  nothing, so the plane's own mapping of those five words is **unmeasured**: no
  real agent ran under herdr-core in these probes.

## What has not run

The plane's side of this design has run in the suite against the Stub herdr
world since step 3 (issue #409): the start's dialect, the prompt, the Close
and the residue cleanup, the Restart seam that repeats the recorded host's
dialect, and the launcher, panel, and Key guide frames per host all stand in
the suites named in the table below, beside the shared controls' own suites.
What has not run is the same boundary it was before, and
it stands below, each one owed by the change that lands it:

- No plane command has ever gone to a real herdr-core host: no start, prompt,
  roster, wait, read, kill, or removal, and no Observation cycle over a real
  herdr-core roster. Every herdr-core command the plane runs in the suite runs
  against the Stub herdr world, and the version read the boot runs is the one
  host command a real boot sends, a read that starts no core.
- The session-record derivation of ADR 0144, including its ambiguous-match
  answer, against any real runtime directory. The plane derives the path from
  the run's own environment in the tree, and the derivation's test runs the
  rule on a fixture directory.
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
makes it the floor. herdr 0.9.5 is the version of the worktree-layout row;
ADR 0143 records the layout as a contract with herdr's directory naming, and a
herdr that changes it is a measured break, not a silent one.
