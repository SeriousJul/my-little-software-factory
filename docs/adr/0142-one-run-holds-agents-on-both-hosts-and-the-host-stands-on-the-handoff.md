# ADR 0142: One run holds Agents on both hosts, and the host stands on the Handoff

Status: accepted
Date: 2026-11-12

Records that the Agent host is chosen per start and recorded on the Handoff,
that a Restart never switches it, that automatic routes take only the config,
that one run therefore holds Agents standing on both hosts at once, that the
observation cycle reads both hosts and merges them into one list the identity
rule and the Parallel limit read, and that a name live on either host is held on
both. It decides no gate, moves no control, and lands no code; the terms are in
the glossary's **Agent host** and **Host resolution** entries
([ADR 0141](./0141-the-plane-resolves-its-agent-host-herdr-or-herdr-core.md)).

## Context

The operator asked to choose the host at launch, not once per run. Two facts
make that choice a per-start fact rather than a per-run setting:

- The host says where an Agent's terminal stands, which is the same class of
  fact as the workspace, tab, or pane id the Handoff already stores. A Handoff
  whose Agent runs on one host cannot be observed through the other: herdr
  answers no herdr-core terminal and herdr-core answers no herdr pane.
- A Ticket's cycle crosses starts. A Restart reuses the stored environment
  ([the Handoff's own rule](../work-flow/handoffs.md), ADR 0046), and the
  operator edits the host on the same override panel that already carries the
  agent, the Environment, the task type, the model, the Thinking level, and the
  Context window.

A run that can hold both hosts at once puts the question on every reader of one
Agent list. The observation cycle, the Top-up walk, the Parallel limit's seat
count, the row's failure badge, and the Consultation operations all read the
list the plane builds from one host today, and the one-name-one-Agent identity
rule (ADR 0060, ADR 0098) is what makes those reads agree about the same
terminal. Measured on 2026-11-12
([the verification record](../verification/agent-host-herdr-core.md)): herdr
refuses a taken name with `agent_name_taken` and herdr-core refuses a taken name
with `name_taken`, each about its own host alone, so the hosts cannot answer the
identity question for each other. Measured beside it: `hc ls --json` carries no
status word, so a herdr-core poll is one roster read plus one read per Agent.

## Decision

**The host is a per-start choice and a Handoff fact.** The override panel and the
Consultation launcher gain an **Agent host** row beside the Environment row. The
choice the start ends on is stored with the Handoff beside its handles, and the
Handoff detail and the Work queue row name the host as they name the Environment.
No section header carries a host cell, and no key switches a host mid-run: the
launcher and the panel are the only two places a host is chosen.

**A Restart never switches the host.** A Restart observes the terminal where the
Agent already stands, so it takes the recorded host whatever the config says now.
An operator who wants an Agent on the other host starts a new one.

**Automatic routes ask nothing.** The auto top-up's continuation, the Work
queue's Pickup, and every Plane action take the configured host, never a stored
override from an earlier manual start.

**One run holds Agents on both hosts, and the observation cycle reads both.**
Each poll runs both roster reads and merges them into one Agent list carrying
its host. The existing readers take the merged list unchanged: the Startup
grace window, the Missing agent marker, the failure badge, the Top-up walk, and
the seat count all read one list, so no reader grows a host branch.

**One name holds one live Agent across both hosts, and the plane is the one who
says so.** Both hosts refuse a taken name about their own host alone, so the
plane's live-name check runs over the merged list: a name live on either host is
held, and the Agent name collision record names the host that holds it. The
identity rule stays the one rule ADR 0060 wrote - `ownAgentInPane` reads the
merged record and answers whether the pane or terminal holds the Agent of its
own - and it grows no second copy for the other dialect.

**The Parallel limit counts seats over the merged list.** One cap, not one per
host: the cap bounds the machine and the operator's attention, not a host's
process.

**A herdr-core poll costs one roster read plus one read per Agent, and the cost
is a measured line, not an assumption.** At the shipped `max-parallel-agents = 2`
that is three commands per poll on that host. The number lands in
[the verification record](../verification/agent-host-herdr-core.md) beside the
measured poll cost, and `agent-poll-interval-seconds` is the knob if a real
deployment makes it show.

## Considered options

- **One host per run, resolved at boot.** Rejected: the operator asked for a
  launch override, a Ticket can move host across its cycle, and a run pinned to
  one host answers the override with a refusal instead of a start. The resolved
  default still stands in the Plane boot record as the host a start takes when
  nothing overrides it.
- **One Parallel cap per host.** Rejected: two hosts on one machine do not buy
  twice the machine, and an operator watching four Agents does not watch eight.
- **A streaming fact feed instead of a poll** (`hc events`, one JSON line per
  fact). Rejected for cost it does not pay: a long-lived child process is a new
  shape at the Command runner, which carries no streaming today and whose whole
  test seam is a command that answers, and the saving at the shipped cap is two
  commands per poll.
- **Let each host answer its own name collisions.** Rejected: two live Agents
  under one name on one machine is exactly the state ADR 0098's identity tag and
  ADR 0060's one rule exist to make impossible, and the seat count, the failure
  badge, and the in-flight pass would disagree about the same Ticket.
- **Scope the herdr-core roster by label instead of merging both hosts.**
  Rejected as the whole alternative it is: a scoped roster cannot answer the
  name-collision and seat facts about Agents on the other host. The plane's
  labels scope its own reads for forensics; they do not hide the other host.

## Consequences

- The state gains a host fact per Handoff, and every reader of a pane, tab, or
  workspace handle reads the host with it. Old Handoffs take the host their run
  resolved, and no migration guesses a host for a terminal that has since gone.
- The observation cycle issues both roster reads every poll, so the poll's
  command count is a number the record states and the audit of the cycle's cost
  can re-measure.
- The Work queue and the Decision modal show two hosts' Agents in one list, and
  the operator's Goto behaves per host: a focus move on herdr, a stated attach
  command on herdr-core.
- The suite's closed-surface rule (ADR 0132) now covers two dialects, and a
  frame test for the launcher and the override panel exists per host, because a
  control the host cannot run must not appear in the Key guide.
- Screen-reader support remains unverified, as before. No terminal walk ran on
  this host, and no claim about the herdr-core path is extended past the unit
  layer and the hand probes the record names.
