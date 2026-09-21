# ADR 0039: The modal's body is a pane and its decisions a bounded region

Status: accepted
Date: 2026-09-20

## Context

The decision modal and the Live view laid their body and their control rows
out as one stack: the context row, the log, the optional held cause row, and
the action rows, in that order, at the top of a near-fullscreen box, with
whatever blank rows were left falling below.

The control rows are bounded by config, not by the terminal: `decisionFor`
adds one row per outgoing workflow edge target, so a wide workflow graph
offers a dozen. At 100x19 such a ticket left the Turn log one row, and at
100x30 the rows sat flush under the last prose line, in the same columns and
with no line between them. The rows the operator confirms were the only way
out of the modal, and a control region that grows without bound is a log that
shrinks without a floor. The frame also offered no name for the log: a box
bordered `Decision: <title>` held both the text and the choices in one
region.

## Decision

**The modal's box is two regions.** A bordered, titled Body pane holds one
body by itself: the Turn log, or the Agent view of a live turn. Its border
title names the body that shows. A Decision region holds the rows the
operator confirms: the held cause row and the decision rows. The pane's
bottom border is the boundary; the region gets no chrome of its own.

**The regions take their rows in a stated order.** The context row, then the
held cause row, then the pane's chrome, then the Decision region, then the
log. The held cause row stands in the region, above the rows it refuses,
because it qualifies the decision, not the text. The stale-stream note stays
the body's last line, because it qualifies the lines the operator is reading.

**The Decision region is bounded and scrolls.** It shows as many rows as the
box has room for once the log has paid its floor, and it scrolls the rest.
The log keeps a floor of three rows, drops it to one after the pane has
yielded its chrome, and only then does the surface stand down to the size
message. This keeps the documented promise that every workflow edge stays
reachable.

**The pane yields its chrome before the log yields rows.** Padding first,
border second, on the same column floor the box already uses for its own
padding. The pane's chrome, the region's cap, and the scrollbar are decided
at the final size, so the pop-in draws no border the box does not have yet.

**The pane is opt-in per surface.** A surface with no long body: the Missing
modal and the Consultation panels: keeps none, and is not forced to draw an
empty one. An empty body states its reason as one row inside the pane, and
the pane keeps its chrome.

**The availability of the keys follows the facts.** The body's scroll is
unavailable with a reason when the body already fills the pane, or carries
nothing. The region's selection is refused, with a reason on the Message
line, when the region holds one row. The region's range rides the Action bar
behind the selection's hint, on the range anchor the Key guide and the
Message view already use. The body keeps its inline thumb.

**The pane and the box paint one ink.** The control ink's indicator, the
checked essential-indicator pair. No modal states its own border color.

## Considered alternatives

**Cap the control region without scrolling.** Rejected: a handoff row the
operator cannot select is worse than a long frame, and it breaks the
documented promise that every edge stays reachable.

**Group the Handoff rows behind one expandable row.** Deferred as its own
decision. It keeps Close and Goto two keystrokes away at any size, but it is
a second mechanism the floor has not yet needed.

**A second bordered region for the controls.** Rejected: four rows per modal
for a symmetry the pane's own border already earns, and a second chrome-yield
case at the declared minimum.

**A proportional log floor.** Rejected: it makes the region's visible count
change with the terminal's size, which is harder to test and harder for the
operator to learn than one stated floor.

## Consequences

The region's selection, its wrap, its auto-scroll, its visible window, and
its range text are a control behavior, so they live in the shared control
library, one module beside the field, the selector row, and the form, and
the gallery can show a region state without building a modal around it.
`scroll-turn-log` becomes `scroll-body`, because the body it scrolls may be
the Agent view. The in-box hint rows die: the Action bar is the plane's only
place for keys. ADR 0016's held-turn rule keeps standing; only its row's
place moves, from above the actions to inside the region that explains.
