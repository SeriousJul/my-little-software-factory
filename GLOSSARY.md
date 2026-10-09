# Control Plane

The terminal application that observes the software factory and issues work.
It monitors tickets, hands them off to agents, and watches for their completion.

## Language

**Factory**:
The whole software development lifecycle, from ticket to shipped work.
_Avoid_: SDLC, pipeline

**Control plane**:
This TUI.
It observes the factory and issues work to agents.
_Avoid_: dashboard, UI

**Main view**:
The always-present base surface of the control plane. It holds three list sections (Ticket, Consultation, and Work) on the left, and one context-dependent detail pane on the right that shows the detail of the currently selected item.
_Avoid_: dashboard, home, screen, primary view

**Section**:
An independently collapsable list in the Main view. The Ticket section holds the ticket list, the Consultation section holds the Consultation list, and the Work section holds the Work queue. All three can be expanded at the same time. A collapsed section shrinks to its header row, and the cursor's step crosses over it to the next section the terminal shows. No section is ever hidden: the Work section keeps its header row while it is empty (ADR 0049). A Group is inside a section's list, never a section itself.
_Avoid_: tab, pane, view, accordion, group

**Section header**:
The row that names one section of the Main view. A collapsed section is nothing but its header row. The Ticket section's header carries the pipeline counts (open, running, awaiting) with the conditional held count and its bell, then the conditional ignored count - the machine's own fact first, so a short row cuts the count of the pile and never a decision the operator owes. Its corner carries the Queue pause's lamp beside the Auto-handoff mode cell (ADR 0111). The Consultation section's header carries that section's attention facts (awaiting response, recovery). The Work section's header carries the queue's depth. A click on the header toggles that section.
_Avoid_: title bar, tab label, accordion toggle, group header

**List filter**:
A section's view control over which of its own rows exist in the view: the Ticket section's cycle is active, ignored, muted, all, and the Consultation section's is open, closed, all.
It is a view, not factory state, and it says nothing about any Ticket or Consultation. It is not the Grouping axis, which slices the rows that show, and not a fold, which shuts a Group's rows and no more.
_Avoid_: search, hide toggle, view mode, grouping, fold

**Response editor**:
The Interaction mode that composes the operator's answer to an awaiting Consultation. Its draft is a Consultation fact, not an Agent turn, until the control plane sends it.
_Avoid_: reply box, chat input

**Action bar**:
The persistent guide to controls that are relevant to the operator's current interaction mode.
The anchor hint holds the row's end cells: the surface's own Close on a utility overlay, and Help wherever a bar can open the Key guide. A frame too narrow for the anchor states one of its whole keys, and never part of one.
The bar states one meaning per key: where two controls claim one key, only the meaning the current facts run appears.
_Avoid_: status bar, shortcut bar, footer

**Message line**:
The temporary surface for progress, warnings, errors, and other operational feedback.
_Avoid_: status line, notification bar

**Message severity**:
The word and the color one Message fact wears: Working, Info, Warning, or Error. An Error is a try that failed and leaves the work unable to move on without the operator, a Warning is something that did not happen or a condition that stands, and an Info is what a control did or a fact with nothing wrong in it.
_Avoid_: status, message kind

**Message history**:
The Message line's own record of the facts it has been asked to state during one run, oldest first, each with the time of its write. It holds the facts that stand and no progress line, and a run's restart empties it.
_Avoid_: message log, message buffer, scrollback

**Message view**:
The on-demand, read-only presentation of the Message history: every fact the Message line has stated this run, each with its time, its level word, and its full text.
_Avoid_: message modal, error popup

**Fault**:
A warning or an error the plane met on its own rather than an answer to a key the operator pressed. It is the only Message fact that leaves the terminal, so the operator who is away still hears it.
_Avoid_: alert, failure, problem, incident

**Desktop notification**:
The out-of-band signal the control plane sends to the operating system for a Fault. It carries the full text the line truncates, so the operator can read the fact and act on it while away from the terminal, the auto-handoff case first.
The plane sends one per standing fact: while the same fact stands it sends none, and when the fact stands again after a different one it sends.
_Avoid_: toast, system alert, popup

**Theme**:
The set of resolved color roles every control-plane surface paints in. Inside herdr the control plane inherits the Theme from herdr's active theme; outside herdr it keeps its own fixed dark theme. A theme carries an appearance: light or dark. It is distinct from the no-color presentation, which is an axis that works on top of any theme.
_Avoid_: palette, color scheme, skin

**Control catalogue**:
The complete set of controls owned by the control plane, with each control's keys, Interaction modes, availability, and reason when unavailable.
It is the common reference for the controls the operator can use and the controls described by the Action bar and Key guide.
_Avoid_: key map, binding table

**Availability facts**:
The record of state one Interaction mode's controls read. Each mode names only the facts its own controls read, the surface that owns the mode states exactly those facts, and a missing one is a compile error.
It is why a hint, a refusal, and a Key guide row cannot be built from a fact no surface stated.
_Avoid_: control context, context bag, facts bag

**Standing facts**:
The part of the Availability facts the whole plane owns: the run state, the queue pause, the two source counts, whether the Message history holds an entry, the configured Consultation types, and the configured exit key.
One record of them is read the same way in every Interaction mode, and no surface restates one.
_Avoid_: global context, shared facts bag

**Key guide**:
The on-demand description of the Control catalogue, with the current Interaction mode and global controls shown first.
It includes controls omitted from the Action bar and the editing controls of Text fields and Draft fields.
_Avoid_: help popup, keybinding popin, shortcut window

**Auto copy**:
The control plane copies a mouse selection to the clipboard when the operator releases the drag, and the ended selection clears its own highlight. A click that does not drag copies nothing.
_Avoid_: copy-on-select, select-to-copy, clipboard selection

**Decision modal**:
The near-fullscreen Interaction mode above an awaiting ticket: the turn log, the label facts the Transition wrote, and the rows the operator confirms: close, goto, and, when the ticket's new position offers a task, the handoff of that task, or its Plane action (ADR 0068).
The route row stands live while its route is dead and reads as a fact line while the route lives: waiting in the Work queue, starting, or running on its position ticket (ADR 0064). The route confirm ends the ticket's cycle on the confirm's own surface, and the screen falls back to the list, which shows the position the route waits on (ADR 0072).
`e` on a handoff row edits that route's settings before it starts.
_Avoid_: action panel, decision popup

**Body pane**:
The bordered, titled region of a modal's box that holds one body by itself: the Turn log, or the Agent view of a live turn.
Its border title names the body that shows.
_Avoid_: section, turn log pane, log block, transcript pane, detail pane

**Decision region**:
The rows a modal pins to its floor: the held cause row and the Completion decision rows the operator confirms.
It is bounded, so the Body pane always keeps its rows.
_Avoid_: action bar, action region, button row, footer

**Live view**:
The near-fullscreen Interaction mode above a `handed-off` or `running` ticket: the live Agent view of the ticket's agent, streamed, and the one row it proposes: Goto.
When the turn settles for the operator, the same screen carries the decision: the border re-titles from `Live:` to `Decision:` in place, the Body pane holds the Turn log, and the Decision region stands at the box's floor. When the agent goes missing it carries the Missing modal. A settled turn the factory decides for itself keeps the streaming body under the `Live:` border.
The Live view is one Work cycle's screen: it opens on a cycle and ends when the ticket moves to the next one, whatever Ticket state the render that follows answers with.
The route confirm ends the ticket's cycle under this screen, and the screen falls back to the list with it (ADR 0072, ADR 0110).
_Avoid_: watch, live log, agent stream

**Missing modal**:
The Interaction mode above a ticket whose agent is missing: restart or abandon.
_Avoid_: missing panel, restart popup

**Interaction mode**:
The part of the control plane that currently owns keyboard input, such as the list pane or the detail pane of a section, the override panel, the Consultation launcher, the Agent terminal, the Key guide, the Decision modal, the Live view, the Missing modal, or the Message view.
_Avoid_: context, screen

**Text field**:
A single-line control in which the operator enters or edits a free-text value.
In the override panel, the Model is a Text field when the Agent has no Model list.
The Context window is a Text field that takes digits only, because its value reaches the Agent as one argument.
_Avoid_: input, free-text row

**Draft field**:
A multi-line control in which the operator enters or edits text addressed to an Agent.
The Consultation launcher's initial input and the response editor are Draft fields.
_Avoid_: input, textarea, free-text row

**Ticket**:
An actionable unit of work from an external ticket source, carrying the repository it belongs to.
An issue, pull request, security advisory, Dependabot alert, or secret scanning alert is a source fact, not a different factory concept.
_Avoid_: issue, task

**Ticket source**:
A configured feed from an external system from which the control plane gets tickets.
GitHub issues, GitHub pull requests, GitHub security advisories, Dependabot alerts, and secret scanning alerts are separate ticket sources.
_Avoid_: task source, ticket provider

**Source kind**:
The external form of a ticket: a GitHub issue, a GitHub pull request, a GitHub security advisory, a Dependabot alert, or a secret scanning alert.
_Avoid_: ticket type

**Source fact**:
Information owned by an external ticket source, such as its title, source state, labels, or URL.
A refresh can change source facts, but it cannot reset factory state.
_Avoid_: ticket state, factory fact

**Ticket identity**:
The stable external identity of a ticket, independent of the configured ticket source name.
It prevents one external item from becoming multiple tickets when sources overlap or are renamed.
_Avoid_: local id, source name

**Source membership**:
The fact that a ticket currently matches a configured ticket source.
One ticket can have more than one source membership without becoming duplicate work.
_Avoid_: source copy, duplicate ticket

**Stale source**:
A ticket source whose latest refresh failed.
Its last tickets stay visible, but they cannot be handed off until the source refreshes successfully.
The failure pins a warning on the Message line until the source refreshes successfully.
_Avoid_: offline source

**Removed source**:
A ticket source that the operator deleted from the Config file.
The plane stops reading it: its open tickets leave the list, its in-flight tickets stay visible and cannot be handed off, and no warning is pinned, because the removal is the operator's own decision.
_Avoid_: disabled source, dropped source

**Ignored ticket**:
A Ticket the operator has judged out of the factory's way for the foreseeable future by their own act, until they take it back.
Its Ticket state, its Parallel limit seat, and its source facts are unchanged: the ignore says only that the plane starts no Agent on it by itself, and lists it nowhere while it rests.
The ignore hides a resting row and never a live one: a Ticket with work in flight or a decision owed keeps its row beside its own marker, and it goes back into the pile when its cycle ends (ADR 0060).
The pile is the ledger of the operator's own acts: every flagged Ticket stands in it, the covered ones included, because only the key on the row ends an ignore.
_Avoid_: hidden ticket, shelved ticket, buried, wontfix, archived, dismissed

**Muted source**:
A ticket source the operator has judged out of the factory's way by their own act, until they take it back.
The plane keeps reading it, and withholds its tickets: a resting ticket of a muted source leaves the list, and the plane starts no Agent on one by itself (ADR 0070).
The mute is retroactive and reaches the tickets the source brings in after the act, and it is a source's fact, not a ticket's: it stands on the source's row in the state file, and the per-ticket flags of the pile stay their own.
A ticket that works keeps its row beside its own marker, the way the ignore keeps it, and the operator's own hand still starts one.
The `muted` view of the List filter is the ledger of the mute: every ticket of a muted source stands in it, the covered ones included, because only the key on the row ends a mute.
Removing the source from the Config clears the mute: the stronger act wins, and a re-added source comes back clean.
_Avoid_: hidden source, silenced source, muted repository

**Attention band**:
The ticket list's first sort: awaiting tickets first, then the in-flight states, running before handed-off, then open actionable tickets, then open tickets that are not actionable.
The band reads the row's own standing: a source whose read is still outstanding keeps its rows actionable, and only a read that failed, a source that left the Config, or a start that already stands withholds a row (ADR 0126).
Within its band the list sorts by the band's own second rank (ADR 0050, ADR 0065): the live bands by newest external update, the open bands by ticket number ascending with the no-number ticket last, and the ticket identity breaks the tie.
_Avoid_: attention group, list bucket, triage group

**Group**:
A run of ticket rows in the Ticket section's list that share one value of the Grouping axis, under its own Group header.
A collapsed group shows nothing but its header. The order inside a group is the order the flat list holds, band rules and all (ADR 0059), and the groups themselves stand in the group order (ADR 0071).
_Avoid_: bucket, category, folder, section

**Group header**:
The row that names one Group, its count, and the count of held decisions it hides. The cursor can rest on it, and no ticket is selected there. Space or a click on it folds the Group, and opens it back when it is folded. On it, `+` and `-` move the Group to its visible neighbor (ADR 0071).
_Avoid_: section header, divider, group row

**Group order**:
The order of one section's Groups on one axis: the axis' own order of its values, marked by the operator's moves. Factory state on the state file, per section and per axis, the way the axis' value is; a plane with no state file keeps it for the run and writes to nothing.
The axis' defaults: `position` reads the Workflow's own order of its positions with the unmatched position last, `state` reads the Ticket states in the plane's own order, and `repository`, `source`, and `task` read the values by their name with the special value last. A move trades a Group with the visible neighbor above or below it, and one move stores the whole computed order, so a Group the filter hides keeps its slot.
_Avoid_: group sort, group rank, shelf order

**Grouping axis**:
The one fact that splits the Ticket section's list into groups: `none`, `repository`, `source`, `task`, `state`, or `position`. Its value is factory state on the state file, and so is the group order the operator's moves write on it; which groups stand collapsed is not (ADR 0058, ADR 0071).
_Avoid_: group-by field, sort key, filter, view mode

**Issue reference**:
The fact that a pull request closes one or more issues, read from the source.
The control plane stores the identities of the referenced issues on the pull request's membership, and a refresh can change the references.
_Avoid_: link, related issue, cross-reference

**Fixing pull request**:
The open pull request that does a ticket's work: the pull request that closes the ticket, or the pull request whose head branch is the ticket's factory branch, which is the only kind for a security item.
The plane derives it from source facts on every refresh and never stores it. An `open` ticket that has one leaves the ticket list while it stays open (ADR 0042). The rule reads only the rows the sources fetched: the default Pull request source fetches no unlabeled draft, so the draft a failed Pull request open leaves standing on the factory branch covers nothing (ADR 0076).
_Avoid_: linked issue, dependent PR, parent ticket, child PR

**Work cycle**:
One passage of a ticket from `open` through the factory to cycle close.
A cycle can hold several handoffs. Close or abandon ends the cycle and returns the ticket to `open` with an incremented cycle number. A cycle closed while its Agent still works leaves no Completion trace, and the cycle-end gates read that absence as a cycle end that holds nothing (ADR 0031).
_Avoid_: ticket generation, run

**Ticket state**:
The position of a ticket in the factory: `open`, `handed-off`, `running`, `awaiting`.
The external source's own state is a separate source fact, not a ticket state.
_Avoid_: status, phase

**Awaiting**:
The ticket state where the agent has settled its turn, the last message is captured, and no completion decision is made yet.
A route ask leaves this state for `open` with an incremented cycle number in the same write that lands the decision: the turn routed its work, and the cycle ends behind the decision (ADR 0067, corrected by ADR 0072).
_Avoid_: finished, pending review



**Agent**:
An autonomous program that executes a Ticket or leads a Consultation.
The control plane is agent-agnostic and assumes no specific agent runtime (pi, codex, claude code, or others).
_Avoid_: bot, worker

**Agent type**:
The declarative description of a class of agents: its name, how to start it, how its settings (model, thinking level, context window) map to the agent's own parameters, its Model list, which thinking levels it offers, and how to read the settled turn's log.
An Agent is a running instance of an Agent type.
_Avoid_: agent definition, plugin, driver

**Thinking level**:
A standard level of agent reasoning effort: off, minimal, low, medium, high, xhigh, or max.
An Agent type declares the levels it supports and maps a chosen level to its own parameter.
_Avoid_: reasoning effort, effort

**Model list**:
The models an Agent runtime reports as available.
The agent runtime, not the config file, owns this set, and a model outside it is not a valid choice for that agent.
One Model list value is one start argument: a value that cannot travel as a single cell is never offered.
_Avoid_: model catalog, model registry

**Type-ahead**:
The Model row's visible, editable substring search for a Model in the Model list.
The search retains unmatched text and states when no Model matches.
_Avoid_: autocomplete, fuzzy filter

**Setting fit check**:
The check one Agent start runs against the resolved Agent type before its first external change: Model, Thinking level, and Context window must each fit the Agent's mapping, and Model must be on its Model list when that list is available.
The Setting fit module owns the rule and one sentence for each unfit cause. An unfit setting fails the start with a readable reason and leaves the Ticket open. A Model list that cannot be fetched skips the Model list part of the check, and the Agent's own rejection stands.
_Avoid_: preflight, validation gate

**Consultation**:
An operator-started interactive exchange with an Agent in a Repository that is independent of a Ticket and stays open until the operator closes it.
_Avoid_: agent session, quick task

**Consultation type**:
A configured kind of Consultation that selects an Agent type and default Environment, then combines fixed opening instructions with the operator's initial input.
_Avoid_: quick template, session template

**Consultation state**:
The position of a Consultation: `queued`, `unscheduled`, `opening`, `working`, `awaiting-response`, `missing`, `failed`, `closing`, or `closed`.
_Avoid_: status, Agent state

**Awaiting response**:
The Consultation state where the Agent waits for operator input and the operator has not responded or closed the Consultation.
The Agent waits when it has settled its turn, or when it shows an approval or question UI (Blocked).
_Avoid_: blocked, idle, done

**Queued**:
The Consultation state where the Consultation waits in the Work queue for its pickup: a free Parallel limit seat, the queue's resume while the queue pause stands, or the checkout its start works going free (ADR 0049, ADR 0052, ADR 0113). It holds no environment and no Agent until the pickup starts it.
_Avoid_: pending, waiting to start

**Unscheduled**:
The Consultation state where the Consultation exists but is not started and is not in the Work queue. It waits for the operator to schedule it, start it, or remove it.
_Avoid_: parked, on hold

**Response draft**:
Operator input saved for an `awaiting-response` Consultation but not yet accepted by its Agent.
_Avoid_: queued response, pending prompt

**Consultation launcher**:
The Interaction mode that collects a Consultation type, Repository, and initial operator input before opening a Consultation.
_Avoid_: new consultation modal, quick prompt

**Replacement Consultation**:
A new Consultation opened with recovery context and an explicit link to a missing or failed Consultation.
It never closes or hides the Consultation it replaces.
_Avoid_: retry, resumed Consultation

**Agent view**:
The scrollable presentation of an Agent's current and recent terminal output inside the control plane.
It does not promise a normalized conversation transcript.
_Avoid_: transcript, chat history

**Captured history**:
The saved operator inputs and settled or partial Agent output shown when live Agent output is no longer available.
_Avoid_: live output, exact transcript

**Session view**:
The presentation of an Agent's session record in the Consultation detail: the operator's inputs and the Agent's messages in order, with one short note per tool call.
It is the detail's default body for open and closed Consultations while the record is readable. Otherwise the detail falls back to the Agent view for an open Consultation and to the Captured history for a closed one.
_Avoid_: pi view, transcript, chat

**Agent terminal**:
The Interaction mode that shows an Agent's terminal and forwards operator input to it while reserving a configurable, keyboard-layout-independent control to return keyboard ownership to the control plane.
_Avoid_: terminal handoff, attach mode

**Observation cycle**:
The poll the control plane runs over its own in-flight work: it reads the Agents herdr lists, settles the turns the Agent's session record shows ended, fires each completed turn's Transition, decides each settled turn, runs the Work queue's Pickup, and makes the one automatic Top-up add.
It runs whether Auto-handoff mode stands or not: the mode decides what the cycle may start, never whether it runs. Its own brakes - the Dispatch pause, the Startup grace, the Attempt hold, the Failed-start park - are derived on every cycle and never stored.
_Avoid_: observation loop, agent poll, watcher, scheduler

**Blocked**:
The observation that an Agent shows an approval or question UI.
A Ticket stays `running`; a Consultation moves to `awaiting-response`.
_Avoid_: stalled, waiting

**Missing agent**:
The observation that the stored pane is gone or holds no Agent, past the Startup grace of a started one.
The operator must explicitly recover or close the affected work.
_Avoid_: dead agent, orphaned

**Stale agent observation**:
The condition where the latest Agent poll failed or was unreadable.
The last known Consultation states stay visible and cannot become `missing` from that poll.
_Avoid_: missing Agent, Herdr offline

**Spinner**:
The animated control of the shared control library: a braille glyph that steps one frame every about 100 ms beside the written word the surface names. It drives its own frames the way the Decision modal's pop-in drives its own, so a frame snapshot taken at the mount reads the first frame and holds. The word carries the meaning, so the no-color presentation keeps it and drops only the color. A ticket in the Starting window wears it in place of its state badge (ADR 0030).
_Avoid_: progress bar, loader animation, hourglass

**Starting**:
The window during which a ticket's Handoff is claimed and not yet settled, or the ticket is `handed-off`: the agent is being started, or it has started and its work is not yet observed.
The ticket's row and detail wear the spinner face in place of their state badge during the window (ADR 0030). A claim a crashed run left behind is not this window: the next boot settles it as a failed start, so the ticket wears no starting face over it (ADR 0041).
_Avoid_: boot, launch, pending, startup

**Queue wait**:
The window in which a ticket's start waits in the Work queue for its pickup: a free Parallel limit seat, or the queue's resume while the queue pause stands.
Every start takes the window the same way: the item the ask enqueues holds its place there, and the ticket the item names keeps its `open` state and wears the `queued` badge in place of the state badge while it waits (ADR 0064). The routed start's source ends its cycle at the ask, so the window stands on the position the item names, and the source stands open behind it (ADR 0072).
Every start takes the wait before the pickup starts it, and a free seat starts it in the same tick (ADR 0049).
The ticket keeps its state, and its row and detail wear the `queued` badge in place of their state badge, the way the Starting window wears the spinner face. The badge is not a ticket state: the section counts, the pickup gate, and the state file all keep the ticket's state.
_Avoid_: queued state, pending, on hold

**Staging**:
Who put a Work queue row in the queue: `automatic` for a row one of the observation cycle's walks added, `operator-staged` for a row an operator's ask left there when no Parallel limit seat stood free (issue #223).
The word the `handoff queued:` and `handoff started:` lines state beside the origin, so a reviewer reading the record tells the factory's own row from the operator's. Staging is not the origin: the origin names the path the row came from - an open ticket, a Workflow route, a Restart - and the staging names who asked for it. The automatic walks' hold line names it too, so a row the operator staged that holds an owed continuation out is stated as the operator's row and never as a continuation (issue #223).
_Avoid_: manual row, auto row, source

**Startup grace**:
The window from a handoff during which the agent's idle report is its boot, not a turn end, and a pane herdr has not listed yet is its boot, not a Missing agent (ADR 0021).
The window holds until the agent's session record shows the turn ended: a working report marks the ticket running, but it does not end the window, because herdr's status is not evidence the turn ran (ADR 0017). Past the window, a turn the record does not show settles `no-turn` and holds.
_Avoid_: boot delay, settle delay

**Reclaim**:
The observation that an Agent herdr reports working or blocked in the pane of a handoff whose work cycle already closed.
The poll records it as a handoff of the ticket's current cycle and runs the ticket again, so the list never reads `open` over live work.
_Avoid_: orphaned agent, re-handoff, resume

**Restart**:
A recovery Handoff after a Missing agent.
It repeats the interrupted Handoff's choices and counts toward the Handoff limit.
The automatic Restart is the one fresh-work add a standing queue row does not hold out, and its row enters ahead of the standing rows: the seat the Missing agent left is its own (ADR 0108).
_Avoid_: retry, Workflow Handoff

**Stale Agent output**:
The condition where the latest read of an Agent terminal failed.
The last Agent view stays visible while lifecycle observation continues.
_Avoid_: stale Agent observation, missing output

**Recovery required**:
The condition where a Consultation cannot continue or close without an explicit operator decision, such as after a missing Agent or interrupted resource change.
It stays separate from `awaiting-response`, where the Agent needs ordinary input.
_Avoid_: awaiting response, blocked

**Recovery panel**:
The Consultation confirmation Enter opens on a broken or stuck record, with the rows that record can still take: Recover and Close on an interrupted opening, Replace and Close on a missing or failed one.
A `closing` Consultation keeps its recovery in the close panel's Retry and Force-close rows instead.
_Avoid_: error dialog, retry box, close panel

**Close**:
The operator action that ends live work, answered by the Delete key in the Ticket and Consultation sections (ADR 0122).
On a Ticket it ends the work cycle, runs the Close cleanup, and returns the ticket to `open` with an incremented cycle number. A Close on a settled turn records the `closed` decision on its trace; a Close on an in-flight turn ends the cycle with no completion trace, because the turn never settled (ADR 0031).
On a Consultation it verifies the Agent's identity, then stops the Agent and cleans up the environment the Agent holds, keeping the worktree and branch. When no Agent is found it issues no command and retires the record, its owned resources recorded as remaining (ADR 0044).
It asks for confirmation when it stops a live agent.
_Avoid_: stop, kill, abort, cancel

**Force-close**:
Closing a Consultation record after resource cleanup cannot be confirmed.
It records the resources that might remain and never removes a worktree or branch.
_Avoid_: abandon, force delete

**Remove**:
The act that takes an item out of where it stands: a waiting start out of the Work queue, or a finished Consultation record and its history out of the plane.
It is what the Delete key answers where no live work is in flight, and it never ends a work cycle: that act is the Close.
_Avoid_: delete, cancel, drop, clear, discard

**Goto**:
The control that moves herdr's view to the Agent's pane from a Ticket or Consultation row, key `g` in both sections.
It is navigation: it changes no ticket, work cycle, or Consultation record. It is the one focus move the control plane makes, and the only one the operator asked for at a key (ADR 0061). Its confirmation names the workspace the view landed in.
_Avoid_: jump, follow, attach

**Handoff**:
Assigning a ticket to an agent type and an environment with a task type, and starting the agent's execution.
It asks Herdr for the ticket's stable Agent name, which names that ticket and no other (ADR 0098), and takes the name of its work cycle when the ticket's own Leftover environment still holds the stable one.
A worktree Handoff of a pull request ticket works the branch its pull request holds - the issue and the pull request of one cycle share the branch, the worktree, and the workspace - and works the ticket's own factory branch only when the pull request's branch cannot stand in the repository (ADR 0112).
When a pane the plane cannot tie to the ticket holds the stable name, the start fails and leaves the Agent name collision on the ticket (ADR 0107).
_Avoid_: assign, dispatch, launch

**Plane action**:
The work of an action task type, which the control plane executes itself through the Command runner. It holds no Agent and takes no Environment, so it opens no work cycle, holds no Parallel limit seat, and settles no turn.
The plane action is a named built-in with its own typed settings, and the shipped set holds the merge of a pull request. Its start is a Work queue item like any start, and the queue pause holds it while it stands. The Dispatch pause holds its automatic add, and the Handoff limit counts its attempts.
Its run takes the Shared checkout hold of its pull request's Repository from its claim until its run settles, so a merge, a worktree Handoff, and a worktree Consultation of one Repository never reach that checkout at the same time, and the hold is not a Parallel limit seat (ADR 0109, ADR 0113). Its own commands work the Repository through the source, not the checkout (ADR 0109).
Its run holds its Ticket's re-ask from the pickup's claim until the run settles: the claim removes the queue row, so the queue's one-item rule cannot see a run in flight, and a second ask in that window would run the same merge twice over one pull request (ADR 0104). The automatic walks read that mark as a standing gate before they ask, so one merge earns one ask, and the ask's own guard still answers the ask that crosses the mark (ADR 0128).
Its attempt is a fact on the ticket, outside any work cycle: the time, the task type, the outcome, and the reason. A merge that finds its pull request already merged settles `merged`.
Its outcome fires the task type's Transition the way a `completed` settle does, on both outcomes alike, and the fire's fact lands on the attempt's record, because no Completion trace stands for it.
The successful merge leaves the projection at once: the merged pull request retires, and so does every issue it closed on the merge, the way the next source refresh would (ADR 0068).
The fire's successful label write converges the projection at once: the ticket's newest membership wears the labels the fire wrote, and the position the machine derives stands on them without waiting for the source's next read (ADR 0079).
A blocked attempt whose label write failed holds the auto top-up's re-ask of the action until every one of the ticket's active sources has re-read the ticket after the attempt: the fire could not move the labels, the position still offers the merge the block could not move, and only the read that outruns the attempt settles the position on the source's own labels. The hold is silent, and it holds the automatic adds only: the operator's confirm passes it (ADR 0077). A failed Handoff start keeps the same hold over its own re-ask, and both channels read the one rule (ADR 0101).
_Avoid_: handoff, automation, command

**Route close**:
The act the handoff ask of the Decision screen makes on the settled turn's environment, at the ask: a direct start closes it before the handoff builds its own, and a start that waits in the Work queue closes it at the enqueue. It is non-destructive: a worktree environment loses its herdr workspace, and the checkout and the branch stay, so the handoff reopens the worktree in a fresh workspace - on its branch when a worktree holds it, or by the path it stands in, on the branch the agent left it, when no worktree holds the branch - and a live-worktree environment loses its tab beside its shared workspace. It is the ask's act: the automatic route and the Restart keep the stored workspace and reuse it. The merge ask closes at the ask, whichever hand asks it, and it is the one ask that leaves this reach: the operator's confirm and the auto top-up's continuation both take the settled turn's environment down through the Close cleanup, so a worktree environment loses its checkout with its workspace and keeps its branch, because the merge builds no environment of its own, retires the ticket the moment it lands, and leaves no later turn to read that checkout (ADR 0046, ADR 0068 as amended by ADR 0099, ADR 0124). A refused close is a line, not a failure: the handoff runs on the stored workspace it could not take down (ADR 0046).
_Avoid_: workspace cleanup, environment teardown

**Handoff attempt**:
The durable record created before a handoff makes its first external change.
An unresolved attempt prevents another handoff of the same ticket after a crash.
An attempt that settled `failed` started no Agent and left no Handoff: it counts toward the Handoff limit, it stands as the Attempt hold (ADR 0101), it counts toward the run the Failed-start park stands on (ADR 0106), it may leave the Agent name collision on the ticket (ADR 0107), and it states itself in the record as the `handoff start failed:` line beside the `handoff started:` line the start wrote (issue #295).
_Avoid_: pending ticket, handoff state

**Attempt hold**:
The condition in which a ticket's newest Handoff attempt settled `failed`, or its newest Plane action attempt blocked, and not every one of the ticket's active sources has re-read the ticket since that attempt's outcome landed.
The start changed nothing on the source, so the position still offers the task the failed start already tried and every other top-up gate still reads clear; the read that carries the ticket's current facts is the signal the next ask waits for. One active source whose last read still predates the attempt keeps the hold, so a ticket with several active sources waits on its slowest source's refresh.
Any failed start sets it - the automatic ask, the operator's confirm, a pickup, and a force-dispatch all leave the same attempt row - because a start that never reached its Agent refused for a reason that says nothing about who asked. It is silent, and it holds the auto top-up's automatic adds only: the operator's confirm, the pickup's claim, and a force-dispatch pass it. Both start channels read the one rule, and an attempt still in flight holds nothing - the unresolved attempt is what the claim gate owns (ADR 0077 as extended by ADR 0101).
_Avoid_: retry cooldown, backoff timer, dispatch block

**Failed-start park**:
The condition in which a Ticket's newest Handoff attempts, in one unbroken run, all settled `failed`, and the run reaches half the Handoff limit (ADR 0106).
The Attempt hold waits out one failure for the source read that carries the Ticket's current facts. That is the right wait for one failure and the wrong one for a cause outside the Ticket: the read lands on every refresh and says nothing about the failure, so the hold is one refresh of delay and the loop runs one failed start per refresh until the Handoff limit stops the Top-up and leaves the Ticket open with no fact saying why. The park is the second brake, and it is a standing fact rather than a silent skip: while it stands the Top-up adds no automatic start for the Ticket, the row and the detail name it, the record names the hold once, and the Message line states it once as the standing warning the Desktop notification carries (ADR 0080). It arrives before the Handoff limit, so the operator meets the loop while the cap that ends a work cycle still stands behind it, and the cap stays the one number the operator sets.
Any Handoff attempt that settled otherwise, or one still in flight, ends the run: a start that reaches its Agent clears the park and the automatic adds resume on the same rule, while a manual start that fails extends the run, because the refusal it met is the refusal the park names. The operator's own act on the Ticket - its ignore, or the mute of one of its sources - answers the failure and takes the fact off the row. Like the Attempt hold, it gates the automatic adds only: the operator's confirm, the pickup's claim, and a force-dispatch pass it.
_Avoid_: failure backoff, circuit breaker, dead letter, retry budget

**Handoff dispatch**:
The module that owns every start: the claim and its hard start checks, the Work queue's enqueue and Pickup, a Plane action's ask, the external work that builds the Environment and starts the Agent, the settle, and the Close cleanup of an ended cycle.
Every start reaches it through one ask, whatever asked: the operator's key, a route the operator confirms, a Restart, or the Observation cycle (ADR 0049, ADR 0097). It owns the start lines the record carries, and it asks for the seat reading the Parallel limit owns rather than deriving its own.
_Avoid_: dispatcher, dispatch loop, start handler

**Observation dispatch port**:
The four calls the Observation cycle may make of the Handoff dispatch: the Handoff ask, the Plane action's ask, the Work queue's Pickup, and the Close cleanup. The Handoff dispatch interface extends it, so the cycle holds the module and still cannot reach the operator's calls - a force-dispatch, a row's removal, the close of a cycle whose turn never settled - or the run's teardown.
_Avoid_: dispatch callbacks, dispatch hooks, observation adapter

**Auto-handoff mode**:
The mode of the factory in which the control plane tops up the Work queue by itself and decides its settled turns without the operator, within the configured limits: a continuation first, then a restart, then an eligible open ticket, one item at a time, the continuation asked before the pickup and the rest only into an empty queue (ADR 0051, with the step order ADR 0094 sets).
The mode is factory state on the state file: it survives a restart and a dev reload, and a fresh state file starts with the mode off. The operator changes it with the `a` key in every Interaction mode except the field modes and the Agent terminal, with the F5 alias in the field modes (ADR 0111).
_Avoid_: auto dispatch, dispatch mode

**Parallel limit**:
The maximum number of works in flight, counting a ticket Handoff and a Consultation alike. A seat is held by an in-flight ticket whose agent the latest poll listed, by every in-progress handoff, by a started agent still inside its Startup grace (ADR 0021), and by a Consultation in `opening` or `working`.
It gates every start: a start that cannot take a seat waits in the Work queue for its pickup (ADR 0049). A Plane action's start takes no seat, because it holds no agent: the pickup runs it whatever the limit reads (ADR 0068).
The seat a Missing agent left is reserved: the Pickup hands it to that Ticket's own Restart row and to no other start, and the Top-up asks that row past the rows standing in the queue (ADR 0108). A seat no Restart can take - the flag, the Handoff limit, the Operator-decides brake, or the mode stands - is not reserved.
It is not the only gate the Work queue has, and it says nothing about the Shared checkout hold: a start that waits on a checkout takes no seat, and the Pickup reaches the starts behind it (ADR 0109).
_Avoid_: concurrency cap, max agents

**Shared checkout hold**:
The fact that one start is working a Repository's shared checkout, held from that start's claim until the start settles.
Three starts take it: a Handoff whose Environment is a worktree, which creates that worktree out of the checkout, the merge Plane action, the other start of the pair the record measured, and a Consultation whose Environment is a worktree, which creates that worktree out of the checkout the same way (ADR 0113). The hold names the Repository the start works - the pull request's Repository for a merge, the Ticket's Repository for a worktree start, the Consultation record's Repository for a worktree Consultation - so a Ticket listed in two Repositories holds one checkout and not the pair. The hold is keyed by the one spelling the plane holds a Repository by, and it stands beside the Parallel limit and is never counted against it. A worktree Handoff holds the checkout only for its start, not its turn: the Agent works inside its own worktree, so the checkout is free the moment the worktree stands.
A start that finds the checkout at work stays in the Work queue with its place, its state, and its `queued` badge, and the record names the wait once while it stands: a handoff row and a Consultation row alike, for the Consultation row's wait is the row's, named the way the handoff's wait is named (ADR 0113). The wait is bounded by the checkout work's own budget, read on two clocks that end different things: the hold's age ends the hold, because a holder past the budget is a start that stopped answering and the Repository keeps working, and the waiting row's own wait ends the row, because a Repository that is busy says nothing about a hung run. The Pickup states a hold its budget ends even when no start waits for that checkout, so the record never leaves a checkout at work forever in silence. Each clock states its own fact, so the two read apart. The bound is per waiting row, not per Ticket (ADR 0109, ADR 0049).
A Consultation row that has waited past the bound is refused the way a dropped item is named: its record settles `failed` with the fact, its row leaves the queue, and the record's line wears the Consultation's own name. A direct start of a record that holds no row - the record the operator's start now ran on - names the wait to the key instead: it answers with the fact, it starts nothing, and the record keeps the state it wears (ADR 0113). A recovery that re-runs the opening a record holds with no pane is another start, and it crosses the same gate at its claim: it holds no queue row either, so a held checkout answers the operator's key with the fact, it starts nothing, and the record keeps `opening` (ADR 0113). A Consultation whose Environment is a live-worktree takes no hold: the operator chose and owns the checkout that start works (ADR 0113).
_Avoid_: repository lock, checkout lock, merge lock, serialization

**Work queue**:
The ordered, durable list through which every start passes: a manual Handoff the operator asked for, a routed ticket's start, a Consultation in `queued` state, a Plane action's start, and the automatic adds the auto top-up makes (ADR 0049, ADR 0051). The routed item names its source: the source's cycle ended at the ask, and the item stands as the route's own fact while it waits (ADR 0072). The queue holds at most one item per ticket: a second add of a ticket that already waits is refused, and the first item keeps its place.
The queue's order is the order the pickup takes the rows in. Every row enters at its tail except the automatic Continuation, which takes the place of the first automatic open-ticket or restart row: the seat a settling turn freed belongs to that turn's own next step (ADR 0094).
The pickup is the only starter of a queued start, and a pickup attempt ends in start or drop, never in stay: a dropped item leaves the queue with its warning, and the queue never holds a failing item, so it cannot jam (ADR 0049). A pickup is a claim like any other: it puts the ticket in the Starting window, and it holds its seat even while the herdr seat keeps the work parked. The operator promotes and demotes an item with `+` and `-`, force-dispatches it over the cap, removes it, or pauses the queue itself: a removed Handoff item is cancelled - a manual start leaves its ticket in the state it wears, and a route the operator removes leaves its mark on the turn's trace, so the auto top-up does not bring the route back (ADR 0069, corrected by ADR 0072) - a removed Consultation item is unscheduled and keeps its record, and the queue pause holds the drain while it stands (ADR 0052). A removal ends the whole waiting start, including a claim the pickup already made and parked.
_Avoid_: dispatch queue, pending list, execution queue

**Pickup**:
The pass that starts the Work queue's items for the free seats, in queue order.
It is the only starter of a queued start, and it runs every observation cycle in both modes, with an immediate pass after every enqueue (ADR 0049).
A pickup runs every hard start check the direct start runs, and an attempt ends in start or drop, never in stay (ADR 0049).
_Avoid_: dequeue, scheduler, drain

**Force-dispatch**:
The Work queue control that starts the selected item immediately, even when the Parallel limit is full.
It re-runs every start check the pickup runs and skips only the cap, and it still starts while the queue pause stands: the brake holds the automatic pickup, not the operator's explicit ask (ADR 0052).
A force-dispatch that fails leaves the item out of the queue, as a pickup failure now does (ADR 0049): a Consultation's start that fails is a terminal record, and its item leaves with it.
_Avoid_: manual override, bypass

**Start mode**:
The fact a start line names: the path that took the seat for a queued start. `pickup` for the Work queue's Pickup, `force-dispatch` for the operator's key on the waiting row, and `direct-ask` for the row the operator's own ask started at once, on the immediate pass that ask ran (ADR 0092).
The mode names the path that ran the start, never the ask that made the row: a row the operator asked for that waited in the queue reads `pickup` when a later cycle takes it.
It is not the item's origin. The origin says where the ask came from (`open`, `workflow`, `restart`); the mode says which path started it.
A Consultation's start line names it too: `pickup` for the Work queue's Pickup of a `queued` record, and `force-dispatch` for the operator's start now key on the record (issue #220, ADR 0102).
For a Consultation the mode names the key, not a crossing of the Parallel limit: the key names its mode whatever the seat reading says, so `mode force-dispatch` beside a reading under the limit is a normal start, not a cap breach.
_Avoid_: dispatch mode, launch mode, start path

**Continuation**:
The Next step Auto-handoff mode takes on its own, without the operator's Completion decision: the Next step of an awaiting ticket, or of an open ticket whose newest settled turn recorded an automatic route the operator did not take away, where the decision stands at the ask, the start died, and the walk re-offers the route (ADR 0067, corrected by ADR 0072, decided at runtime by ADR 0092).
The auto top-up adds a continuation before a restart, an open pull request ticket, or fresh work (ADR 0051, ADR 0088). The cycle asks it before the pickup's pass, and its row enters ahead of every row that queued earlier - a fresh-work row and a row the operator staged alike - so the seat a settling turn freed goes to that turn's own next step (ADR 0094, ADR 0100).
That rank is the row's place in the queue's order, not the queue's pace. A continuation already standing means a Workflow route row the queue holds, the factory's own or the operator's route decision alike, and while one stands no new continuation is asked (issue #230).
_Avoid_: follow-up, workflow advance

**Top-up**:
The one automatic add the observation cycle makes to the Work queue: while Auto-handoff mode is on, a continuation, else a restart, else an eligible open pull request ticket, else an eligible fresh open ticket, else nothing (ADR 0051, ADR 0088). The continuation is asked before the Work queue's pickup and waits only behind a Workflow route row already standing - the factory's own continuation or the row the operator's own route decision left there alike (ADR 0094, ADR 0100, issue #230). The rank ADR 0100 gives the owed continuation is its place in the queue's order, and a row that already stands is never overtaken by a row that has not entered. The restart and open-ticket adds run after the pickup and only into an empty queue (ADR 0094). The Missing agent's restart is the exception the seat reservation forces (ADR 0108): the seat that agent left is reserved for that row, so a standing row does not hold the restart out, and its row enters behind the owed continuation and ahead of the standing rows.
The pull request group stands ahead of the fresh group: the work the machine has started on a pull request moves to the end before the machine starts work on a ticket it has not started. The list's order holds inside each group, and a gate that holds one ticket holds that ticket only: the held ticket rests, and the walk falls to the next candidate, as every gate does.
It adds one item per cycle, and only into an empty queue, so the queue never piles. A cycle that asked a continuation asks no fresh work, and the queue then holds at most one fresh-work row beside the continuation it outranks (ADR 0094, ADR 0100). The restart walked past a standing row asks no open-ticket add in the same cycle: the standing row is its hold (ADR 0108).
A ticket whose newest start failed, or whose newest plane action blocked, holds the re-ask until every one of its active sources re-reads it: the Attempt hold (ADR 0077 as extended by ADR 0101). A ticket whose starts keep failing holds it outright: the Failed-start park (ADR 0106). No walk asks a Task type that carries Operator-decides: the flag holds the fresh-work row, the continuation, the restart, and the automatic merge ask alike, and the walk falls to its next candidate (ADR 0117).
A walk whose ask meets a refusal that stands for work the plane already entered - the row that still waits for that ticket, or the Plane action run already in flight (ADR 0104) - takes it as a hold of its own and states it in the record's hold voice: the Message line says the walk held, never that the work could not start, because a refusal of that kind names work the plane is doing (ADR 0125). A refusal that means a start could not run keeps the walk's warning.
_Avoid_: refill, auto dispatch, queue feed

**Queue pause**:
The operator's brake on the Work queue itself: while it stands, the pickup takes no item, the auto top-up adds none, and a manual enqueue that lands waits without starting. A force-dispatch passes it, the way it passes the cap (ADR 0052).
It is factory state on the state file, toggled with the `p` key in every Interaction mode except the field modes and the Agent terminal, with the F4 alias in the field modes (ADR 0111).
It is a brake on the starts, not a stop of the factory: the running Agents keep running, their turns settle, their Transitions write, and the auto Completion decisions keep deciding those turns.
Its face is the lamp in the Ticket header's corner and the shared modal chrome's top border: the lit lamp with the word `running`, the unlit lamp with the word `paused`, the word carrying the meaning and the color secondary (ADR 0111).
It is distinct from the Dispatch pause, which is automatic and holds the top-up's adds.
_Avoid_: dispatch pause, queue stop, brake

**Handoff limit**:
The per-ticket cap on the Handoff attempts and plane action attempts the factory made - the starts that reached an Agent and the starts that never reached one - that stops the close-and-rehandoff loop (ADR 0005 as amended by ADR 0101).
It gates auto-handoff only; a manual handoff or a manual plane action confirm may pass it (ADR 0068).
The Failed-start park arrives at half this cap, so a Ticket whose starts keep failing is held, and named, before the cap is reached (ADR 0106).
_Avoid_: turn counter, dispatch budget

**Dispatch pause**:
The condition in which Auto-handoff mode starts no agent by itself, because the newest Held turn settled `failed`, no turn has settled `completed` since it, and the trace still stands as the decision the operator owes - the Ticket rests `awaiting` on the cycle the trace belongs to (issue #338).
It is derived from the completion traces on every cycle, never stored, so it survives a restart and cannot drift from the fact it describes. It ends at the next `completed` settle, when the operator decides the Held turn that started it, or when the trace stops standing as a Held turn: the Agent of the held turn reports working again and the turn reopens, or the operator closes the in-flight cycle the trace stands in (ADR 0031). It never blocks a manual Handoff or a route the operator confirms, and it holds only the automatic adds of the auto top-up: the continuation, the restart, and the open ticket (ADR 0051).
The auto cell's corner word for it is `held` (ADR 0111), and the word `paused` belongs to the queue pause alone.
It is distinct from the queue pause, the operator's brake on the queue itself (ADR 0052).
_Avoid_: circuit breaker, cooldown, backoff

**Same-type hold**:
The condition in which the Auto-handoff withholds a ticket whose newest turn settled a `completed` turn of exactly the task type it now suggests: the current cycle's settled turn when that cycle settled one, and the newest closed cycle otherwise (ADR 0093).
A completed work needs no repeat, and progress needs a new signal. It is derived from the completion traces on every cycle, never stored, so it survives a restart and cannot drift from the fact it describes. It ends when the suggested task type changes, or the ticket leaves the source list. It gates the auto top-up's open-ticket add and a settled turn's Next step; a manual handoff always passes it (ADR 0026, ADR 0051, ADR 0092).
_Avoid_: dispatch block, retry gate, backoff

**Task type**:
The named description of a kind of work and its Transition, the label facts a completed turn of it writes, or a Plane action's outcome, fires (ADR 0068).
A prompt task type holds its prompt template and the Task profile its handoffs start on. An action task type holds a Plane action instead of the template and the profile, and the two forms never mix on one type. A prompt task type can open a pull request for its ticket's work: the plane makes the Pull request open of it at the Handoff start, and the Agent works the branch the pull request already stands on.
Either form can carry Operator-decides, which parks the type's completions for the operator instead of the machine's decision (ADR 0085).
A Workflow state offers a task type, and the default task type offers one when no state matches. The completion behavior follows the task type to whatever ticket it runs on.
_Avoid_: prompt, template, task

**Task profile**:
The agent type, model, thinking level, and context window a task type starts its handoffs with.
It is a start value: the override panel prefills it, a Transition's agent pin can replace its agent for one handoff, and an operator override beats all of it.
A setting the Agent a Handoff lands on cannot take fails that Handoff with a readable reason, so a reroute that leaves a setting behind is seen, not absorbed.
_Avoid_: run settings, task settings

**Suggested task type**:
The Task type proposed for a Ticket's next Handoff by the task of the first matching Workflow state, or by the configured default task type when no state matches. A first matching state that offers no task - a parking state - suggests nothing, and Auto-handoff starts no Agent on that Ticket.
An Override can replace it for one Handoff, and a manual Hand off of a parked Ticket starts the default task type.
_Avoid_: detected task type, inferred task type

**Workflow**:
The configured machine of the factory: an ordered set of Workflow states, and the Transitions of the task types they offer.
A ticket's position in it is derived from its source facts on every refresh and never stored.
_Avoid_: pipeline, state machine, task rules

**Workflow state**:
A named position in the Workflow. It matches on a source kind, and optionally on a source name, a repository, and label sets (all, any, none). It offers at most one task type.
The states are ordered and the first match wins, so the config author encodes label priority by order. A state that offers no task is a parking state: the control plane does nothing on it, and an external label write is the only engine that moves the ticket.
Its match spec is also the ticket's entry to it: the all and any labels are the state's placement labels, and the Placement derives the write from them (ADR 0045).
_Avoid_: status, phase, stage, ticket state

**Transition**:
The label facts a completed turn of a task type writes. It fires on a `completed` settle, before the Completion decision, and on a Plane action's outcome (ADR 0068), in manual mode and in auto mode alike, and it is idempotent.
It adds and removes labels on the ticket and on its fixing pull request, and a branch chooses between alternative fact sets on a Judgment. After it runs, the label set matches its spec whatever writers ran before, and the tickets' new positions derive from the written labels.
It is the settle-time write; the handoff-time write is the Placement (ADR 0045).
_Avoid_: handoff, label flip, workflow edge

**Scoping label**:
A label a State's match gates a ticket on - its `labels-any` or `labels-all` - that no Transition writes. No fire adds it or removes it, so it is the operator's signal, not the machine's fact. The Repository init creates the ones the config names, because the machine reaches a gate only when the repository holds the label, and a gate the config does not name stays the operator's own to create (ADR 0115). A gate may be the source's own vocabulary rather than a label the operator applies for the machine: the shipped machine gates its diagnosis position on `bug`, the label a repository's triage already writes, and the State order keeps the operator's stronger label ahead of it (ADR 0116).
_Avoid_: entry label, manual label, filter label

**Judgment**:
The condition a Transition branch tests to choose its fact set: the review score against the configured threshold, and whether the fixing pull request is still open.
The score is read from the pull request's comments and its reviews, and the open state from the pull request's own record, straight from the source at settle time; the projection's last refresh stands as the read's fallback. It is never a stored value, and the read takes the template's fixed score line under whatever markdown the post wears around it (ADR 0057).
_Avoid_: verdict, score check, gate

**Review verdict**:
The newest post on a pull request's comment and review timelines that carries the review template's fixed score line. It is the review's feedback to the pull request, read straight from the source, and the record both the score judgment at settle and the rework prompt at handoff decide on.
_Avoid_: last review comment, review comment, verdict post

**Next step**:
The step a settled turn's Transition derives when its label facts land: the task type the ticket's new position offers, the ticket that position stands on, and whether the step is a Handoff or a Plane action. It is derived, never stored: the position's ticket can leave its source between the write and the start.
A Transition whose facts land on a position that offers no task derives no Next step, and the cycle closes where the machine put the ticket.
_Avoid_: auto advance, auto-advance, next task

**Completion decision**:
The choice made on a settled agent turn: close the cycle, go to the agent, or run the task the ticket's new position offers: a handoff when the task type is a prompt task, a Plane action when it is an action task (ADR 0068).
On a task type that carries a Transition, the Transition has written its label facts before this choice.
_Avoid_: verdict, outcome

**Operator-decides**:
A property of a Task type: the type is the operator's own, and Auto-handoff mode neither decides its settled turns nor asks its starts. On the completion, the turn rests in `awaiting` for the operator, the environment and the agent stay untouched, and the operator's explicit close or route still runs (ADR 0085, renamed by ADR 0092, extended to the starts by ADR 0117).
The brake covers every automatic add the Top-up makes: the open Ticket's fresh-work row, a Continuation whose Next step lands on the type, the Restart of a Missing agent, and a Plane action's automatic merge ask. A Next step the flag holds is a gated step: the automatic rule answers `hold`, so the turn rests in `awaiting` with no decision, and the Decision screen, the Message line, and the record state the gate. The gate is read before the Handoff limit's, which degrades a held step to a cycle close, so a step the operator owns is never closed away by a cap.
The fresh-work and restart skips are silent, the way the Same-type hold and the parking state are silent: the flag is the operator's own config, not a fault the plane diagnoses, and the row's task badge and position name already answer what the Ticket waits on.
It is the only per-task-type brake Auto-handoff mode carries, and it gates the machine's own asks only: the operator's handoff, the override panel, the Decision screen's row, the Pickup of a standing Work queue row, and a force-dispatch all start the type.
_Avoid_: no-auto-decision, no auto close, manual completion, no-auto-start

**Turn log**:
The agent's messages of one settled turn, in order: the agent's text, and one short note per tool call.
The control plane builds it from the agent's session record when herdr reports one, or from the terminal capture when herdr does not.
_Avoid_: agent log, transcript, terminal capture

**Turn end cause**:
Why an agent's settled turn ended: `completed`, `failed`, `aborted`, `truncated`, `quota`, `no-turn`, or `unknown`, with the agent's own text as its detail.
`quota` is the cause of a turn the provider refused because the model's usage limit or quota was reached, read from the agent's own error text.
_Avoid_: rate limit, usage limit, throttle

**Model tier**:
A named, ordered group of models of one agent kind.
A work configured on a tier runs on one of its models and, on a `quota` turn end in Auto-handoff mode, falls back to the next model of the same tier.
It never falls to a different tier: a work configured on one tier stays on that tier.
_Avoid_: model chain, model pool, fallback list, Model list
`no-turn` is the cause of a settle whose session record is readable and holds no turn: the turn never started. `unknown` is the fail-open cause of a record that cannot be read. It is the agent's fact, not herdr's status, and it says nothing about whether the work itself succeeded.
_Avoid_: done, exit reason, stop reason, agent status

**Held turn**:
A settled turn whose Turn end cause is `failed`, `aborted`, `truncated`, or `no-turn`, and that no decision has landed on.
No automatic decision runs on it: the ticket rests in `awaiting` until the operator decides. A turn that settled `completed` or `unknown` is never held; `unknown` fails open, so it auto-decides as it normally would.
_Avoid_: stalled turn, blocked turn, failed turn

**Completion trace**:
The durable record of a settled agent turn: task type, agent, model, thinking level, context window, completion time, turn log, last message, turn end cause, and decision.
A cycle holds one trace per settled turn.
_Avoid_: console dump, session file

**Context window**:
A whole count of context tokens an Agent starts a Handoff or a Consultation with.
It is a setting of a Task profile, a Consultation type, and an Override, and each Agent type maps it with its own command-line template.
There is no configured default: a value left out stays with the Agent, because one count cannot fit every model.
A count the resolved Agent maps no template for, or a value that is no count at all, fails the Handoff with a readable reason instead of starting the Agent without it.
_Avoid_: token limit, budget, autocompact

**Environment**:
The place where an Agent executes a Ticket or leads a Consultation.
Kinds: a live worktree (an existing checkout), a worktree (a fresh git worktree), and a container (a future kind, not yet built).
_Avoid_: sandbox, isolation

**Live checkout conflict**:
The condition where an Agent would start in a live checkout already used by another active Agent.
It blocks the start unless the checkout holds a safety confirmation for the current set of conflicting identities: an Agent that no Consultation or ticket owns takes the herdr Agent pane id, and an Agent owned by an open Consultation or a running ticket takes that Consultation's or ticket's identity.
The operator confirms once per conflict set: the confirmation belongs to the checkout, is durable, and stores the confirmed set with its time. A later launch into the checkout asks again only when a conflicting identity appears that is not in the confirmed set. A shrinking set never re-asks, and each checkout keeps its own set, so one checkout's confirmation never silences another checkout's question.
_Avoid_: dirty checkout, parallel limit

**Leftover environment**:
The workspace, tab, or Agent of a ticket's closed Handoff that Herdr still holds after its Close cleanup.
It is a durable fact on the ticket, visible in its row and in its detail, and its cleanup runs in herdr, not in the control plane.
It never blocks a Handoff of that ticket.
_Avoid_: orphaned agent, zombie workspace, stale checkout

**Agent name collision**:
The condition where Herdr refuses a Handoff's stable Agent name because a pane the control plane cannot tie to that ticket holds it (ADR 0107).
It is a durable fact on the ticket, worn by its row as `name held` and stated in its detail with the pane, the workspace, the name that pane holds, and since when.
The plane owns no cleanup for it: the pane is no workspace, tab, or Agent the plane made, so the operator closes it in herdr.
While it stands the Top-up adds no automatic start for the ticket, the record names the hold once with the refusal the attempt stored beside the ticket, and the Message line states it once as the standing warning the Desktop notification carries (ADR 0080). Like the Attempt hold and the Failed-start park, it gates the automatic adds only: the operator's confirm, the pickup's claim, and a force-dispatch pass it.
The one act that clears it is the Handoff the operator starts themselves: a start that reaches its Agent took the name, the fact leaves with it, and the automatic adds resume with no second act. A start that fails for another reason never asked for the name, so it answers nothing about it. The ticket's own ignore, or the mute of one of its sources, answers the refusal the way they answer a run of failed starts.
It is not a Leftover environment, which is the ticket's own workspace, tab, or Agent Herdr still holds and whose cleanup the plane asks herdr to run. A holder the ticket's own handoff recorded is a Leftover environment and never a collision, and neither read answers for the other.
_Avoid_: name conflict, stuck retry, orphaned agent

**Leftover worktree directory**:
The directory Herdr's naming rule reserves for a Branch, standing on disk after Git stopped recording the worktree that held it.
It blocks a fresh worktree for that Branch, and it is no tool's to remove: the control plane moves it aside under a name that says what it is, and never deletes it (ADR 0062).
It is not a Leftover environment, which is a workspace, tab, or Agent Herdr still holds.
_Avoid_: stale checkout, orphaned worktree, ghost directory

**herdr view**:
What one herdr client shows: the workspace that client is looking at, in its own window.
Each client keeps its own view, and a view persists while the workspace it shows exists. A focus request that arrives from outside a client (a CLI command, an Agent, the control plane) moves every attached client's view, never one client's alone: herdr has no command that aims a view at a single client. The control plane never moves a view on its own (ADR 0061); the one move it makes is the Goto, at the operator's key. The surviving exception is herdr's own: when the workspace a client is viewing stops existing, that client falls back to the session focus.
_Avoid_: focus, screen, pane, window, session focus

**session focus**:
The workspace herdr's server treats as active.
It is not any client's herdr view: a client keeps its own view while that workspace exists, and a client that is not viewing a workspace is not moved by what the session focus does. The control plane reads no fact of the session focus. Its close, its reuse, its grouping, and its naming all go by the workspace, tab, or pane id the plane recorded, or by a checkout path, so where the session focus lands after a close is harmless to the plane's work (ADR 0061).
_Avoid_: herdr view, current workspace, active pane, focus

**Placement**:
The label write the control plane makes when a manual Handoff's final task type differs from the task the ticket's position suggests: it places the ticket on the state that offers the chosen task type (ADR 0045).
The target is the first state, in machine order, that offers the task and whose non-label conditions hold for the ticket. The write adds the target state's all and any labels and removes the placement labels the state does not name, so the ticket's new position offers the chosen task. It is idempotent: a label set that already matches the spec writes nothing.
It runs on the ticket being handed off, never on its fixing pull request, after the Handoff's claim and before the agent starts. An infeasible placement, or a failed write, refuses the Handoff start with a readable reason and leaves the ticket's position as it was.
_Avoid_: label flip, position edit, entry write

**Placement label**:
A label named in a Workflow state's all or any match set. The Placement write owns this set: it adds and removes placement labels, and it never touches a label no state names, such as a severity label. A state's none set names exclusion, not ownership.
_Avoid_: entry label, position label, workflow label

**Pull request open**:
The act the control plane makes when it starts a Handoff of a task type that opens a pull request: the pull request of the ticket's factory branch is opened as a draft before the Agent's first commit, with the title and body the plane writes. The Agent never creates the pull request; it works the branch the pull request already stands on. A branch the remote did not carry first receives one empty hold commit from the plane, because the source opens no pull request on a head that carries no commit ahead of its base, and the hold stays on the branch: the Agent's commits stack on it, and a squash merge leaves it out of main. A pull request the branch already carries is reused, and no second one is opened. A failed act refuses the Handoff start with a readable reason. A Handoff that fails after its push - the draft create's exhausted retry window included - leaves the factory branch standing on the remote and the draft it opened standing on it: the next Handoff of that ticket reopens the worktree on the standing branch, fetching the remote copy when the checkout no longer carries one, and reuses the standing pull request, so one ticket wears at most one Fixing pull request across any number of failed starts. A cycle end closes a draft pull request the ticket still wears, never a pull request the machine has published. It runs only on a worktree environment, because only that environment holds the factory branch.
_Avoid_: agent pull request, pull request creation, branch open

**Pull request publish**:
The act the Transition fire makes before its label write when a completed turn of a task type that opens a pull request settles: it marks the ticket's own draft pull request ready for review, so the machine can act on it and the list can hold it. The fire reaches the draft through a direct source read, because a draft pull request the machine has not labeled never stands in the ticket list. A pull request whose head carries no work against its base - its tree stands alike to the base's, the plane's hold commit included - is treated as the missing pull request: the fire records the skip on its own reason, publishes nothing, and writes no label, and the re-fire sweep lands the labels when work appears.
_Avoid_: PR ready, draft clear, label flip

**Override**:
A one-shot change to the settings of a single Handoff, made in the override panel before the Handoff starts.
The panel edits an open Ticket's next Handoff and a handoff the Workflow position suggests alike: `e` on a decision row opens the panel on the settings that row resolved. A decision row that offers a Plane action offers no override, because the action holds no settings the panel can edit (ADR 0068).
It applies to that Handoff only and never becomes a new default; a later handoff the Workflow position suggests resolves its own profile instead of inheriting one.
A Restart repeats the interrupted Handoff's choices as recovery.
The settings are: Agent type, Environment kind, Task type, Model, Thinking level, and Context window.
A Task type the ticket's position does not offer runs the Placement: the ticket is placed on the chosen task's state before the Handoff starts (ADR 0045).
_Avoid_: custom setting, tweak

**Config file**:
The TOML file at `~/.config/my-little-software-factory/config.toml` that carries the handoff defaults (agent, environment, task type, model), the limits, ticket sources, the Workflow and its states, agent types, task types and their Transitions, state file, and repository mappings.
A missing file is seeded from the Default configuration on first run. An invalid file stops the control plane with a readable error before the UI starts.
_Avoid_: settings file, preferences

**Default configuration**:
The TOML the package ships, used to seed the Config file on first run.
It carries the Workflow machine (its states and the task types with their Transitions) and the `consult`, `diagnose`, `pair`, and `improve-codebase-architecture` Consultation types, and it is meant to be extended by the operator.
_Avoid_: built-in defaults, factory settings

**Repository identity**:
The stable, host-qualified identity of a source repository, such as `github.com/owner/name`.
It stays distinct from the repository's display name, clone URL, and local checkout path.
_Avoid_: repository name, clone URL

**Repository mapping**:
The config entry that pins a repository identity to an explicit checkout path.
It is the first place the control plane looks for a repository.
The `[repos]` table and the `[[sources]]` blocks are the two regions the control plane writes back (ADR 0103).
_Avoid_: repo config, alias

**Convention checkout**:
The default home of a repository: `~/src/<repository name>`.
The second place the control plane looks when no repository mapping exists.
_Avoid_: default path, home

**Sibling clone**:
The clone of a repository to a sibling path (for example `~/src/billing_1`) that the control plane makes when the convention checkout holds a different repository.
The handoff runs at the sibling, the control plane warns, and the repository mapping records the path.
_Avoid_: fallback clone, mirror

**Repository init**:
The act the operator confirms from a Group header to make one repository factory-ready: it creates the missing labels the machine names - the labels its Transitions write, the labels its States gate on, and the triage labels - writes the convention files and the Agent skills block on the remote default branch through a throwaway worktree, and registers the repository's sources in the Config file, one issues feed per issue-side gate (ADR 0075, ADR 0115).
No Repository init runs by itself: the plane signals the unprepared repository, and the operator's confirm starts the act (ADR 0075).
_Avoid_: repo setup, bootstrap, provisioning

**Initialized repository**:
A repository whose init fact stands in the state file: its labels are created, its convention files are written, and its sources are registered.
The fact holds the hash of the settings that generated the content, the pushed commit, and the time.
_Avoid_: registered repo, onboarded repo

**Init drift**:
The condition where an Initialized repository's stored init fact no longer matches the current settings, so its generated content is stale.
A change of the settings that determine the generated content stands every Initialized repository in drift at once, with no read of the repositories, and the re-init through the same act clears it.
_Avoid_: out of sync, stale setup, config drift

**Convention files**:
The repository files the control plane owns and generates for an Initialized repository: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, and `docs/agents/domain.md`.
A re-init overwrites them; a hand edit stands until the next re-init overwrites it, and the panel names every differing file before the confirm.
_Avoid_: agent docs, setup files, skill config

**Agent skills block**:
The `## Agent skills` section of a repository's agent instruction file: `CLAUDE.md` when it exists, else `AGENTS.md`.
It is the only region of that file the control plane touches: a re-init updates it in place, from its heading to the next level-two heading or end of file, and never the surrounding sections.
_Avoid_: skills section, agent instructions

**Repository init panel**:
The confirm surface the `i` key opens on a Group header of the Ticket section while the Grouping axis is `repository`.
It states the repository, the labels and files the act will write, the differing files it will overwrite, the target branch, and the rows Init and Cancel.
_Avoid_: init modal, setup popup

**Command runner**:
The single egress for external commands: the control plane runs every herdr, git, GitHub CLI, and agent model list command through it.
The automated tests inject a double at that seam that records safe command facts, so no test touches a real herdr session, repository, ticket source, or agent runtime.
Two doubles stand there: the fake command runner answers a command the test pins, and the Stub herdr world answers from a standing world (ADR 0132).
_Avoid_: executor, spawner

**Frame rig**:
The shared test module that boots the control plane at a fixed terminal size and runs its controls for the frame tests.
It resolves a Control catalogue id to the key the Action bar states on the current frame, sends that key, and waits for one named outcome: `opens`, `closes`, `refuses`, `shows`, `hides`, `moved`, or `quiet`.
A test names a control and an outcome; it names no key, no frame predicate, and no deadline. The frame poll, the passive-effect flush, a surface's key ownership, and the deadline all stand behind the interface.
_Avoid_: test harness, frame harness, UI test helper, key presser

**Seeded plane**:
The test module that opens one whole control plane standing behind one interface: the state file, the config file, the home and checkout directories, the Command runner double, the Ticket source double, the clock, and the Plane boot the control plane runs from.
A test names the standing it drives - `open`, `in-flight`, `awaiting`, or a closed cycle - in the domain's own words; it names no aggregate call, no directory, and no Plane boot field.
It reaches no operator path, and it holds no rule of the plane: where a standing needs a rule, it calls the module that owns the rule.
The state module's own suites stand outside it, because a fixture in front of the seam a test exists to read would hide that seam.
_Avoid_: test fixture, test world, harness, seeded app

**Plane boot**:
The one record the control plane boots from: the validated config, the Command runner, the config file path, the home directory, the state aggregates, the bound Ticket sources, and the file logger. Every field stands; none is left out.
The production entry fills it from the startup module's result, and a test fills it from the Seeded plane. The two differ by the Loop policy they name, never by a field one of them omits.
_Avoid_: app props, boot options, partial boot

**Loop policy**:
The fact of which background loops a run starts: production polls the Ticket sources and the Agent observation at the config's interval, a held run starts neither, and a polled run starts both at an interval the test rig names.
The policy stands in the Plane boot, so a run never settles its loops by which fields were left out.
_Avoid_: poll interval flag, no-state mode, projection mode

**Documentation site**:
The static site that GitHub Pages publishes from the `docs/` folder.
It shows the published subset (the ADRs, the standards, and the guides) and keeps the agent instruction, verification, and research folders out of the build.
_Avoid_: website, docs site, blog

**Worktree base**:
The commit a new worktree environment is created from.
It is the remote default branch of the repository's origin after a fresh fetch, and falls back to the local checkout's HEAD when the fetch or the ref is unavailable, with a note on the handoff.
The default branch comes from the `origin/HEAD` symref, then `origin/main`, then `origin/master`.
The same rule serves a ticket handoff worktree and a Consultation worktree.
_Avoid_: base commit, starting point, worktree origin

**Stub run**:
A control plane run that plays the factory flow against a Stub world, with no real GitHub.
Its Command runner serves every GitHub command from the Stub world, and runs every other command - git, herdr, and the agent runtimes - for real.
The real TUI, the real state file, and the real agents run in it, so a human operator walks the flow the way the factory walks it.
_Avoid_: mock run, dry run, simulation

**Stub world**:
The file-backed stand-in for the GitHub side that a Stub run plays against.
It holds the stub repositories and their issues and pull requests, the labels, the comments, the review verdicts, and the merge gate fact of each pull request.
The plane's own label writes, merges, and comments mutate it, and a restart reads it back.
The world file is the source of truth of the Stub run, and the seed is its initial content.
_Avoid_: mock server, fake GitHub, test double

**Stub herdr world**:
The automated suite's double for the herdr and git side of the Command runner seam (ADR 0132).
It holds the checkouts and what each holds, the default branch, the branches and worktrees, the workspaces, tabs, panes, and standing Agents, and it answers every herdr and git command the plane builds from that state.
A create adds to it, a close removes from it, and a start stands an Agent in a pane, so a later read agrees with the command that came before it.
It answers only the command shapes the plane builds and refuses every other one, and it refuses what it does not hold with herdr's own code.
It stands behind the Seeded plane's runner, and it is in memory: no operator edits it, so it holds no file.
_Avoid_: herdr mock, fake herdr, herdr stub, command stub table

**Quality audit**:
The one command this repository runs to check itself: `bun run audit` runs the type check, Biome, jscpd, and the code-scanning read, and prints one payload on stdout - a status line, one count per metric, then the findings as `path:line rule message`.
`--changed` narrows the findings to the files that differ from the changed base, and never the counts.
It writes no report file inside the worktree, and it runs no test suite (ADR 0121).
_Avoid_: quality gate, lint run, code audit, sonar scan

**Quality baseline**:
The committed count per metric that the Quality audit refuses to let grow: a count above it fails the audit, and a count below it is rewritten down in the same change.
It stands in `.quality-baseline.json`, beside the `.quality.json` that states the audit's own values, and no threshold lives in the audit script (ADR 0121).
_Avoid_: debt list, ignore list, suppression list, ratchet
