# ADR 0074: The rework prompt carries the pull request's review verdict

Status: accepted
Date: 2026-10-01

## Context

The `needs-work` state offers the rework task type on a pull request
ticket. The shipped rework template told the agent to "read last review
comments" itself, so the agent hunted the review's feedback across the
pull request's own timelines.

The plane already knows where the feedback lives. At the settle, the
score judgment reads both posting timelines - the pull request's issue
comments and its review bodies - and takes the newest record that carries
the template's fixed score line (ADR 0047, ADR 0053, ADR 0057, ADR 0063).
That record, the review verdict, is exactly the input the rework agent
needs, and the plane read it one settle earlier for the judgment. The
handoff, by contrast, rendered only the ticket's projected facts: title,
description, labels, source facts. The verdict never stands in the
projection, so the rework agent started blind and spent its own turn on
the read.

## Decision

**The rework prompt carries the review verdict.** A new known
placeholder, `{review-verdict}`, joins the prompt placeholders. When a
task type's template references it, the handoff reads the verdict live
from the source at the prompt render: the same two timelines, the same
newest-score-carrying-record rule, and the same per-timeline fail-open
the score judgment uses. The read is gated on the template's reference to
the placeholder, the way the judgment gates its two timelines on its
score branch: a template that does not reference the placeholder issues
no read.

**The fill is the verdict's body under a one-line header that names the
posting timeline and the post's time.**

**The read degrades to a fact line and never blocks the handoff.** When
no record carries the fixed score line, the fill is `No review verdict
found on the pull request.`. When every timeline's read fails, the fill
is `The review verdict read failed: <reason>.`. The handoff goes ahead
either way, and the template keeps the fallback instruction: when the
section carries no verdict, the agent reads the pull request's comments
itself. The plane's fill states the fact, and the template states the
instruction.

**The shipped rework template moves with the placeholder.** The "Read
Comments" step dies, a `### Review verdict` section leads the prompt,
and the first instruction corrects the code according to the verdict
above and carries the fallback. The template change reaches existing
installs by the operator's hand only, the policy under which the review
template's outcome line moved (ADR 0053): an install that keeps its old
template loses the injection and gains nothing, because a template that
references no placeholder issues no read and renders no section.

## Consequences

- The rework agent starts with the review's feedback in its prompt: it
  does not spend its turn hunting the timelines, and it cannot settle on
  a wrong or stale post. The judgment's record is its input, so the
  rework corrects what the judgment measured.
- A pull request a human labels `needs-work` by hand, with no verdict
  post, stays handable: the fill is the fact line, the template's
  fallback instruction runs, and the agent reads the timelines itself.
- The handoff issues at most two source reads, and only when the
  template asks for them. A handoff whose template references no
  placeholder is unchanged in its command stream.
- The verdict read now stands at two points, the settle's judgment and
  the handoff's prompt. The rule is one and the read is live at both, so
  the two points never decide on different records for the same posts.
- A restart of a rework handoff re-renders the prompt and re-reads the
  verdict, the way the first handoff does: a new agent session starts
  with the same context.
- The placeholder joins the config check's known list and the
  configuration docs' placeholder table. Any other brace pair in a
  template stays a startup error.
