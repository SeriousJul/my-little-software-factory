# ADR 0040: Every near-fullscreen surface is shared chrome

Status: accepted
Date: 2026-09-20

## Context

The Live view was the plane's last near-fullscreen surface outside the
shared chrome. It drew its own bordered box, ran its own keys on a local
handler, and had no Action bar and no Message line. Its settled sub-mode
reused the decision's layout math by importing it from a sibling surface,
and its keys: select, confirm, edit, scroll, cancel: had no catalogue
controls at all, so the Control catalogue, the Action bar, and the Key guide
could not name what the operator was pressing.

The Decision modal already moved its layout to the shared chrome, but its box
accepted its body as raw children and its border color as a per-caller
argument, and the plane spelled the same border ink five ways.

The Live view also switches sub-modes under the operator: `liveMode` re-
derives stream, decision, missing, and closed from the ticket's facts on
every render, so the turn can settle while the operator reads the stream,
and a settled turn on an auto-close task type keeps streaming.

## Decision

**The Live view is a shared-chrome surface.** It renders on the modal
surface, gains the Message line and the Action bar, and its keys dispatch
from the Control catalogue. Its stream sub-mode answers to a `live-view`
mode of its own, whose controls are the body's scroll, the Goto, and the
cancel. Its settled sub-mode dispatches in the existing `decision-modal`
mode, which `CONTEXT.md` already states: the Live view becomes the Decision
modal when the turn settles.

**The sub-mode switch happens in place.** One surface, one pop-in per
opening. The border re-titles `Live: <title>` to `Decision: <title>` when
the turn settles for the operator, and the chrome's body API owns the prefix
so the two paths into the decision, Enter on an `awaiting` ticket and a turn
settling under an open Live view, cannot drift. The bar's hints change with
the mode.

**The in-box hint row dies.** The Action bar is the plane's only place for
keys, at every size and in every surface, and the row it frees goes to the
body.

**The chrome owns the box.** A modal's body is a typed body region, not raw
children, so a surface cannot hand the chrome a box of its own. The border
ink is the control ink's indicator, the checked essential-indicator pair,
and no surface states a border color. The architecture check refuses a
surface that paints action rows without the library's region state, so the
drift the local Live view carried cannot come back.

**The Decision region's selection is a control behavior.** It lives in the
shared control library, one module beside the field, the selector row, and
the form: the selection, its wrap, the auto-scroll that keeps the cursor's
row visible, the visible window, and the range text. The chrome and the
catalogue consume it.

## Considered alternatives

**Keep the Live view outside the chrome, and give it only the pane.**
Rejected: it is the drift the shared-control standard names, and it leaves
the plane's largest key system outside the catalogue.

**Close and reopen on settle.** Rejected: a second pop-in in the middle of an
unread log moves the text under the operator's eyes, and it throws away the
scroll position the operator held.

**Two catalogue modes for the two sub-modes.** Rejected: the settled
sub-mode is the Decision modal by the glossary, and duplicating a control
set under a second name is a second truth for one key.

## Consequences

The guide images of the Live view and its settled turn are re-captured from
the production binary, and the operation page's promise that the border
reads `Live: <title>` in every state is replaced by the re-title rule. The
verification record gains unverified targets for the Live view's new bar and
Message line, and for the nested border at the declared minimum. ADR 0039's
pane and region are the Live view's body, and this ADR is what lets the pane
mean the same thing on both surfaces.
