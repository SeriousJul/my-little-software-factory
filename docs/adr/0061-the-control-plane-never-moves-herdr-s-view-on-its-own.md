# ADR 0061: The control plane never moves herdr's view on its own

Status: accepted
Date: 2026-09-25

## Context

The operator works in one herdr window, watching an agent's pane. When the
control plane ends an environment, herdr's view jumped to the plane's own
workspace. The jump was a two-hop: the view landed on a neighbour workspace,
because herdr moves its focus when a workspace disappears, and was then
dragged back to the plane by the `workspace focus` command the plane sent
after every successful close. The operator lost their place twice for a
bookkeeping act they could not see.

The worst case has no keypress beside it. A route whose start waited in the
Work queue closes the previous handoff's environment when a seat frees, so
the focus command ran at a moment the operator had asked for nothing
(ADR 0046). The Consultation close did the same whenever its plan command
named a workspace, and the Close cleanup did it on all three of its
workspace branches.

The compensating call was written against a herdr that had one focus for the
whole server. That is no longer the model, and the facts are worth recording
because the fix looks wrong from the plane's side: removing a focus command
after a close that moved one feels like the bug, not the cure.

The behavior was read from herdr 0.9.1 source, at two places:

- `src/server/headless/client_views.rs`, in
  `handle_api_request_with_shutdown_check`: a request on the public socket
  moves every attached shell client only for `workspace.focus`, `tab.focus`,
  `pane.focus`, `agent.focus`, and a create that asks for focus.
  `workspace.close`, `tab.close`, and `worktree.remove` are not in that set;
  they only reconcile client locations.
- `src/server/clients.rs`, in `ClientView::reconcile`: a client keeps its
  viewed workspace while that workspace exists, and falls back to the session
  focus only when it no longer does. This is the one surviving jump, and it
  is herdr's own: no client is ever shown a destroyed workspace.

Two more herdr facts shape the decision:

- Each herdr client keeps its own view, and a focus request from outside a
  client moves every client's view. Per-client views are herdr's shipped
  model, delivered in herdr 0.9.0 (#3526), and the request to target one client
  from a command was closed as not planned (#4014): a custom command uses
  the public socket, and the socket moves every client. There is no command
  that can aim only the operator's own window.
- herdr's own session focus after a worktree close lands on a neighbour, and
  that is an open upstream issue (#1303). Nothing in the plane reads the
  session focus, so it stays cosmetic here.

The plane already asked for no focus when it built an environment: every
workspace create, worktree create, worktree open, and tab create carries an
explicit `--no-focus`. Keeping that flag is a contract, not noise: herdr's
changelog records that the create-focus default regressed once and came back
(#3766, v0.9.1).

## Decision

**The control plane never moves herdr's view on its own.** It asks for no
focus when it builds an environment, and it asks for none when it ends one.

The one focus move the plane makes is **Goto**, key `g`, which the operator
presses and which asks herdr to take the view to the agent's pane. It is
navigation the operator chose (ADR 0033), and it stays exactly as it is,
including the confirmation that names the workspace it moved to.

Three consequences follow for the code:

- The handoff module's shared "return herdr's focus to the plane's workspace"
  helper is deleted, not silenced, with all five of its call sites: the three
  branches of the Close cleanup that follow a worktree removal or a workspace
  close, the route close at the ask, and the Consultation operations' close.
  Nothing replaces them.
- The plane holds no id for the workspace it runs in. The close-cleanup
  options, the dispatch module's options, and the Consultation operations'
  options each carried a control-plane workspace id, and the app read it once
  from `HERDR_WORKSPACE_ID` at start-up. Every one of those is gone, so no
  code path can aim herdr's focus at it again. The herdr environment mark
  stays: the plane still detects that it runs inside herdr, and still reads
  herdr's config for the Theme (ADR 0024).
- A static check over the plane's own sources refuses a workspace focus
  command anywhere in it, allows an agent focus command only at the Goto
  seam, and refuses a herdr create that does not state its no-focus default.

## Consequences

- The view never moves on a close. The two-hop is gone because the plane
  sends no second hop, and the first hop does not happen: herdr 0.9.1 leaves a
  client's view alone for a close of a workspace the client is not viewing.
- The one surviving jump is hers, not the plane's. When the plane closes the
  one workspace the operator is viewing, herdr moves that client to its
  session focus, because the workspace the client was looking at no longer
  exists. The operator is never shown a destroyed workspace, and no plane
  code can prevent the move.
- Removing the compensating focus call costs no bookkeeping. A herdr refusal
  of a close still comes back as one readable reason, still stands on the
  Message line, and still records the surviving environment as the ticket's
  leftover fact (ADR 0012).
- The tab and pane close paths keep their shape. They never sent a focus
  command; the assertion that they stay that way now covers the workspace
  paths too, so the rule has one negative assertion per close, not a rule per
  branch.
- The plane depends on nothing herdr reports as the session focus. Reuse
  finds a workspace by its checkout path, grouping and naming go by the
  handles the plane recorded, and every herdr command the plane sends names
  an explicit workspace, tab, or pane id. Focus drift after a close is
  therefore harmless to the plane's own work.
- Goto becomes load-bearing in a new way. Because it is the only focus move
  the plane makes, it is the only way the operator can get the plane to bring
  the view to an agent, and its wording still has to name the workspace the
  view landed in. The earlier note that a CLI focus is only a hint, because
  each client keeps its own view, is wrong for herdr 0.9.1: a focus request
  on the public socket moves every client, and that is what makes Goto a move
  rather than a hint. The operation pages and the verification record carry
  the corrected wording.
- The rule has no mode. There is no setting that asks the plane to return the
  focus, because a setting would mean a mode in which the plane moves the
  operator's view without being asked.
- What a close destroys is unchanged. The seat, the leftover-environment
  accounting, the worktree-versus-tab reach, and the route-close decision all
  stand as ADR 0046 and ADR 0012 write them. **This amends the close behavior
  ADR 0046 describes; it does not change that decision.** ADR 0046's route
  still closes the previous handoff's environment at the ask; only the focus
  command that followed the close is retired.
- The suite cannot observe a window, so the live herdr 0.9.1 walk is not
  claimed by any test here. It stays with the operator: a Close cleanup of a
  worktree workspace while another workspace is viewed, and a queued route
  item's close that lands while the view is elsewhere. Until the operator
  runs it, the verification record names it incomplete.
