---
title: Consultation
description: Start, answer, close, delete, and schedule a Consultation, and the override panel that edits a handoff before it starts.
---

# Consultation

![A working Consultation in the detail pane, with the Agent's own output
below its facts](images/consultation.png)

A Consultation works an agent outside the ticket loop: a grilling session, a
pair programming pass, an answer to a question. It never touches your
tickets.

## The Consultation controls

- `c` launches a Consultation. The launcher names the type, the repository,
  and your input; the Consultation starts on the agent, environment, model,
  thinking level, and context window its type names. A Consultation the
  config cannot start never takes a row: the refusal stands on the Message
  line, and the launcher keeps your unfinished form for the fix.
- `Enter` answers the selected Consultation: it opens the response editor on
  an awaiting one, Agent interaction on a working one, and - on a broken or
  stuck one - a recovery panel with the options its state offers. The editor
  keeps your draft between starts, `Enter` sends the response, and `Esc`
  closes it with the draft saved.
- `w` closes the selected Consultation. A close that stops a live agent
  confirms first and names what it keeps; a `missing`, `failed`, `queued`, or
  `unscheduled` one closes without a dialog.
- `d` deletes a closed or an unscheduled Consultation.
- `s` schedules an `unscheduled` Consultation back into the Work queue.
- `f` cycles the history filter through open, closed, and all. `r` refreshes
  the Consultation list. `x` folds or restores the section, and `h`/`l` move
  between its list and the detail.

## The override panel

![The override panel on an open ticket: the Agent, Environment, Task type,
Model, and Thinking rows with the handoff actions under the bar](images/override-panel.png)

`e` on a ticket opens the override panel: the rows you edit and the keys you
press, before a handoff starts. The rows are the Agent, the Environment, the
Task type, and the settings the agent takes - the Model, the Thinking level,
and the Context window. The rows start on the settings the selected task type
resolves to, so the panel shows what the handoff will run on.

- `Up` and `Down` move the rows, `Tab` and `Shift+Tab` step between them, and
  `h`/`l` or `Left`/`Right` cycle a row's value. `Enter` confirms the
  handoff; `Esc` cancels it.
- The **Model row** takes type-ahead: every letter you type jumps the row's
  value to the first model the agent offers whose name contains what you
  typed. A model the agent does not offer stays on the row with a warning
  until you clear it or choose an agent that takes it.
- The **Context row** takes digits and nothing else: a comma, a space, or a
  letter typed or pasted into it is refused before it reaches the field, so
  the value stays a clean count of tokens.
- A row you leave untouched follows the task type; a row you change stays
  yours for this one handoff. Switching the Task type row re-derives the rows
  you did not touch, so the new task type shows on the untouched rows while
  your changes stand. Clearing a Model, Thinking, or Context row hands that
  setting back to the agent.
- The panel never shows something other than what the handoff sends: a value
  the chosen agent cannot take stays on screen with its warning, so a
  handoff that would fail is visible and readable before you confirm it.

An override never becomes a default: it changes that one handoff only, and
your config file stays as it was.
