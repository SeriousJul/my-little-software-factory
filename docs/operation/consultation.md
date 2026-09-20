---
title: Consultation
description: The Consultation controls, the Entry controls, and the override panel.
---

# Consultation

![A working Consultation in the detail pane, with the Agent's own output
below its facts](images/consultation.png)

## Consultation controls

The Consultation launcher, the response editor, and the Consultation
confirmation panel are shared-control forms: their fields, choices, and
actions are the modules in [src/components/shared](../../src/components/shared), so
the keys they answer with are the keys the override panel answers with. The
Consultation section's own list and detail, the Agent terminal, and the Agent
interaction mode dispatch from the same catalogue as the Ticket section, so
every Consultation control appears in the Action bar and the Key guide with
its availability and reason.

- `j` and `k` cross into the Consultation section from the last row of the
	Ticket list, and back again from its first. Once the cursor holds a
	Consultation, `c` launches a Consultation, `f` cycles the history filter
	through open, closed, and all, `w` closes the selected Consultation, `d`
	deletes a closed or an unscheduled one, and `s` schedules an `unscheduled`
	one back into the Work queue (issue #91): the record returns to `queued`
	with its item at the queue's tail, and the pickup is its only starter. A close that stops a live Agent - an opening,
	a working, or an awaiting-response Consultation - confirms first: the
	dialog names the Agent and states what the close keeps, the worktree and
	branch on a worktree Consultation and the checkout on a live-worktree
	one. A `missing`, a `failed`, a `queued`, or an `unscheduled`
	Consultation closes without a dialog: these hold nothing live to stop,
	and the `queued` one's Work queue item leaves with the record. A
	`closing` one opens the Retry and Force-close recovery panel instead,
	and
	a `closed` one refuses. `h` or `Left` moves between the section's own
	list and the detail pane, and `x` collapses or restores the section under
	the cursor. The Consultation that needs the operator keeps its attention
	on the section header: an awaiting response wins, and among the recovery
	items the oldest wins.
- In the launcher, `Tab` and `Shift+Tab` move between the two choices, the
	Draft field, and the two actions; `←→` choose a type or Repository and
	move the caret in the field; `Enter` adds a line inside the field and runs
	the action it stands on; `F3` copies the selected text; `F1` opens the Key
	guide, `F2` the Message view. `Esc` closes the launcher and keeps the
	unfinished form - the same text, the same Consultation type, the same
	Repository - for the rest of this run; `Discard draft text` is the action
	that deletes it. A Consultation starts on the agent, environment, model,
	thinking level, and context window its type names, each one passed through
	the agent's own template, so the type must name an agent that maps every
	setting it sets. The start runs the Setting fit check first and fails with
	a readable reason when its agent cannot take one of them, before it touches
	herdr or the repository. A submit into a full Parallel limit creates the
	record in `queued` state and enqueues it in the Work queue instead of
	starting it (ADR 0034): the queue's pickup starts it when a seat frees, and
	the notice names the record and the queue it waits in. Recovery re-checks
	the stored record, so a config
	change cannot start an opening Consultation without the settings its record
	names.
- `Enter` answers the selected Consultation with the surface its state needs
	(ADR 0038): it opens the response editor on an awaiting one and Agent
	interaction on a working or blocked one, and it opens the recovery panel on
	a broken or stuck one. That panel's rows come from the record's state: an
	`opening` Consultation gets `Recover`, which retries the opening this run
	left behind, and `Close`, which takes the close path and its dialog; a
	`missing` or a `failed` one gets `Replace`, which opens the launcher on this
	record's recovery context and links the new Consultation to it, and `Close`,
	which retires the record with nothing to stop. A `closing` Consultation
	opens the close panel that already carries its `Retry` and `Force-close`,
	and a `closed` one answers nothing: the line states that the selected
	Consultation is already closed. The editor stores its draft in SQLite,
	`Tab` reaches `Send response` and `Enter` runs it, `Enter` inside the
	field adds a line, `Esc` closes it with the draft saved, and `Discard
	draft` deletes the saved draft. A `queued` Consultation answers nothing
	in this section: it waits for a seat in the Work queue, and its start is
	the queue's Enter (ADR 0034). An `unscheduled` Consultation answers
	Enter with its start over the Parallel limit (issue #91): the start runs
	the queue's pickup with the cap skipped, the line names the cap when the
	seat count stood over it, and the record's own progress line takes over
	from the start.
- `r` recovers a Consultation whose opening was interrupted, and refreshes the
	Consultation projection and the Ticket sources otherwise. It remains
	Refresh even when an awaiting Consultation can also be answered with
	Enter.
- `End` follows the latest Agent output after scrolling. Closed history shows
	cleanup results and retained resources, including resources left by a
	Force-close.
- A blocked Agent uses Agent interaction mode instead of the response editor.
	Every key reaches the Agent except the exit key, whose default is `F12` and
	which the Action bar states while the mode holds the keys; configure
	`interaction-exit-key` with a function key or `Ctrl` plus one letter.

The override panel acts only in the Ticket section, so an unexpected key
cannot fire while the operator works Consultations.

## Entry controls

The basic entry controls are `?` or `F1` for the Key guide, `F2` for a
truncated Message view, and `Ctrl+C` for emergency exit. Use the in-app
guide and the contextual Action bar for the control plane's fixed control set.

### The override panel

![The override panel on an open ticket: the Agent, Environment, Task type,
Model, and Thinking rows with the handoff actions under the bar](images/override-panel.png)

The override panel is a modal. While it is open, the keys of the app below
are inert, and the shared Action bar at the terminal bottom changes between
its list-row, model-row, and text-row modes. `Up` and `Down` move the
setting rows, and `Tab` and `Shift` + `Tab` move the next or previous row
from either row kind. On a list row, `j` and `k` also move the rows, and
`h`/`l` and `Left`/`Right` cycle the value. A free-text row is a standard
single-line input: typed text, the caret keys, `Home` and `End`, `Backspace`
and `Delete`, word deletes, undo and redo, and sanitized bracketed paste all
work in it. It owns printable `j`, `k`, `h`, `l`, `?`, and `m`; `F1` still
opens Help and `F2` the Message view. Enter confirms the handoff; Esc
cancels.

The rows start on the settings the resolved Task profile names (ADR 0009),
so the panel shows what the handoff will run on. The Model row offers the
selected agent's own Model list (ADR 0010). It is a list row that also takes
type-ahead: every typed letter extends the typed text, and the row's value
jumps to the first model whose whole value contains that text,
case-insensitively. The panel's rule is a plain substring test, stricter than
the pattern search the `pi --list-models` filter applies, which lets the
matched letters sit apart from each other. The typed text is never displayed;
the jumping value is the feedback. A run that finds nothing is over, because
a longer run can only match less, so the letter that found nothing starts a
new run and the row keeps answering every letter. On that row `j`, `k`, `h`,
and `l` type letters; only the arrows, `Tab`, and `Shift` + `Tab` move the
selection. While the control plane fetches the list the row shows
`(loading...)` and takes no input, and a value the fetch has not judged yet
shows in the dim tone. When the agent's kind reports no list, or the query
fails, the
row is the standard single-line text field, and an empty list the agent
reports shows `(no models available)`.

The Thinking row is a list of the levels the selected agent declares, in the
order it declares them, so the operator can never choose a level that agent
cannot run. A row shows `(empty)` for an unset text value, `(unset)` for a
list value the operator has not chosen, and `(loading...)` while the Model
list is being fetched. A row owns the keys it needs, so `j`, `k`, `h`, and
`l` type into a row that takes typing, and move or cycle everywhere else;
`Up`, `Down`, `Tab`, and `Shift` + `Tab` always move the selection. The
shared Action bar at the terminal bottom names the panel's controls.

The Agent, Model, Thinking, and Context rows start on the selected Task
type's resolved Task profile: the profile's own value, else `default-model`
for the Model row, else empty, which leaves that setting to the agent.
Switching the Task type row re-derives each setting the operator has not
touched, so an untouched row follows the new Task type while a changed or
cleared row stays a one-shot override. Switching the agent never re-derives
the model: every setting resolves on its own chain. Clearing a Model,
Thinking, or Context row hands that setting back to the agent.

The Context row holds a count of tokens, so it takes digits and nothing else: a
comma, a space, or a letter typed or pasted into it is refused before it reaches
the field, so the value, the caret, and any selection stand exactly where they
were and the row states under itself what it turned away. A paste is refused
whole, never picked over for the digits that sit inside it, so a pasted `1e3`
never becomes `13`. An entry the row took ends that reason, so it never lingers
under a count that has moved on. A count also keeps one spelling: the row folds
a leading zero the way a config file's count is folded, so `007` and `7` reach
the agent as `7`. Digits alone are not yet a count: a row that holds none, `0`
for example, warns and fails its handoff, the way a config file that sets one
fails at startup.

A setting the chosen agent type does not map has no row, so an agent without a
`model` template shows no Model row. One exception keeps a value in reach: when a
row carries a value the selected agent cannot take, its row stays on screen in
the warning tone and writes the Handoff's own sentence on the row under it, so a
handoff that would fail is visible and readable before it is confirmed. That
sentence is characters, not a color, so a panel that paints no color keeps all
of it and a panel too narrow for it states the part that fits. A value cannot
be taken when the agent maps no setting for it, when it lists the thinking
levels it offers and the row holds another one, or when the Context row holds
digits no count makes, `0` among them. A model the
agent's own CLI does not report shows the same warning the fit check will fail on
(ADR 0010); a waiting Model row is not judged, because its list has not arrived
to judge it against. The panel never shows something other than what the handoff
sends, and the row is the only place the operator can clear the value, so it
stays: the handoff fails on it until they clear it or choose an agent that takes
it.

The container environment is a future kind and is not offered by the panel.

The panel sizes itself to the terminal. When the rows do not fit, the value
column shrinks first, then the label column, then the marker. A row that states
a reason takes the row it writes it on, so the panel counts it and the viewport
still keeps the selected row whole. The rows scroll within the viewport when
the height cannot hold them all, and the selected row stays visible. A row
never wraps: it carries less, not broken text. The shared Action bar sits at
the terminal bottom and names the controls the panel dispatches.
