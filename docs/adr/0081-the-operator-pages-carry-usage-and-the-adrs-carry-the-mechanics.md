# The operator pages carry usage, and the ADRs carry the mechanics

Status: accepted.

The documentation site's operator guides (Getting Started, Operation, Work
flow, and Configuration) grew into an implementation write-up: internal
mechanics - the queue's pickup and top-up, state-file internals, seat counts,
label-write convergence - and ADR references on nearly every line. The
maintainer wants the site to focus on usage, from the operator's standpoint.
We decided the operator pages carry usage only - what the operator does, what
the operator sees, and at most a one-to-two sentence "why" note where the
operator gets confused - and the mechanics stay in the ADRs, which remain
published.

## Considered Options

- Keep the ADR references in the operator pages for traceability. Rejected:
  the references did not stop the pages growing, and the traceability already
  lives in the ADRs and the code, so the operator paid for nothing.
- Move the contributor content (the Development pages and the ADRs) out of
  the published site. Rejected: one site and one build. The ADRs are a trust
  signal for a visitor. The rewrite keeps them published, de-emphasized under
  a single Contributing entry, so the operator path is the front face.
- Restructure the operator pages into task-oriented guides. Rejected: the
  Operation pages are a control reference, not a task list. The rewrite keeps
  each page's shape and cuts the internals.

## Consequences

- An edit that re-adds an ADR reference or a paragraph of mechanics to an
  operator page is a regression against this ADR, not an improvement.
- The content conventions doc carries this rule, so the next agent edit keeps
  it.
- The deep detail is not deleted by the rewrite; it stands in the ADRs and
  the configuration key reference.
- The rewrite itself lands per issue #189.
