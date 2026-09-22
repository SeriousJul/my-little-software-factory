# ADR 0052: The queue pause is factory state

Status: accepted
Date: 2026-09-22

## Context

The operator wanted a brake on the Work queue itself: stop the starts
that leave the queue without touching the Auto-handoff mode, the
Dispatch pause, or the Parallel limit. The Dispatch pause is automatic:
a held turn set it, and a completed settle or the operator's decision
ends it (ADR 0016). The Parallel limit is the cap over running work,
not a stop on the queue. Neither is the operator's on or off on the
queue's drain.

## Decision

**The queue pause is factory state on the state file**, the way the
Auto-handoff mode is (ADR 0036): a fresh state file starts resumed, the
`p` key in the Work queue section writes the new value at once, and a
restart finds the brake where the operator left it.

**The brake holds the drain and the top-up.** While it stands, the
pickup takes no item, Consultations included, the automatic top-up adds
none (ADR 0051), and a manual enqueue that lands while paused sits in
the queue without starting. Resuming triggers an immediate pickup pass,
so the queued work starts in the same keystroke.

**The brake does not hold the ask.** A force-dispatch still starts its
item over the cap while the queue is paused: the operator's explicit
intent passes the brake the way it passes the cap (ADR 0049).

**The two pauses stay two facts.** The mode line's `paused` word remains
the Dispatch pause's, and the queue pause shows on the Work section's
header, where the pane owns the state. Both can stand at once, and each
displays in its own place. The `p` toggle joins the Action bar and Key
guide from the queue section as every other queue key does.

## Consequences

- `p` was unbound in the Control catalogue; the queue section takes
  it, and the sections that do not own it refuse it in their own words
  and name it nowhere.
- A paused queue reads as waiting, not as stuck: the items hold their
  places for the resume, the header names the pause, and nothing in the
  queue is in a failure state (ADR 0049), so the resume drains whatever
  the pickup can start.
- The two pauses can stand together: the automatic pause holds the
  top-up's adds, the brake holds the drain, and the operator lifts each
  in its own way, decide the held turn or press `p`.
