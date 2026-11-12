# The Agent host verification

Status: **the decision records stand, and step 1 of the change is in the tree.**
ADR 0141,
ADR 0142, ADR 0143, and ADR 0144 and the glossary's **Agent host**, **Host
resolution**, and **Adoption label** entries landed on 2026-11-12, and the
first step of the change landed beside them (pull request #414): one module
(`src/agent-host.ts`) owns both Agent host dialects, the host word map, and the
host resolution the plane will call once per start - the config, then the
environment mark, then the default - as a tested function beside its marks,
with the config key and the boot statement that call it owed to step 2; the
Stub herdr world answers the herdr-core dialect beside herdr and git, its
closed-surface rule walking the host dialects the module builds, and the check
that refuses a `herdr` or `hc` argument outside the module stands. The plane
still sends no herdr-core command and no launcher or override-panel row exists,
and every plane-side flow on that host is recorded as not run below. Nothing
in this file is a claim about the plane: every herdr-core fact below is a hand
probe of the host program. A check that could not run is recorded as
incomplete; it is not a pass.

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

Everything on the plane's side of this design. Recorded as incomplete, each one
owed by the change that lands it:

- No plane command has ever gone to herdr-core: no start, prompt, roster, wait,
  read, kill, or removal, and no Observation cycle over a herdr-core roster.
- The launcher's and the override panel's Agent host row do not exist, so no
  frame test, no refusal wording, and no Key guide row stands.
- The Goto refusal that states `hc attach <name>` is unwritten and untested.
- The Live view's absence on this host is unwritten; the ANSI stream has never
  been attempted against herdr-core, which answers no styled read.
- The worktree flows of ADR 0143 on this host: `git worktree add` and `remove` in
  the Handoff's path, the reopen-by-branch and reopen-by-path lookups over git's
  record, the Leftover worktree directory move-aside, and the Close cleanup.
- The session-record derivation of ADR 0144, including its ambiguous-match answer,
  against any real runtime directory.
- The Adoption labels of ADR 0141: the Herdr desktop was not running during the
  probes, so no terminal was ever seen in a desktop window through those labels.
  The adoption rule itself is quoted from the desktop app's own generated
  instructions, and the walk is unverified.
- The naming-suite check that keeps the plane's names inside herdr-core's refused
  id shape (the derived row above).
- Two runs of the plane on one machine sharing one herdr-core session: never
  attempted, so the cross-process name-collision case ADR 0142 leans on stands
  unverified.
- The screen-reader path stays unverified for both hosts, exactly as
  [the shared-controls verification record](./shared-controls.md) states, and the
  terminal walks on the theme-inherited paint stay open there. This change makes
  no accessibility claim.

## Issue and version pins

herdr-core 0.1.20 is the release every shape above was read against, and ADR 0141
makes it the floor. herdr 0.9.5 is the version of the worktree-layout row;
ADR 0143 records the layout as a contract with herdr's directory naming, and a
herdr that changes it is a measured break, not a silent one.
