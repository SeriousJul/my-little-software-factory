# Shared control verification

Status: the automated checks pass. The keyboard and visual acceptance targets
were verified in Ghostty and foot, in the dark and no-color presentations,
before the control plane began inheriting the Theme from herdr (ADR 0024); the
terminal walks have not been re-run on the theme-inherited paint, so they are
recorded as not re-verified for it, not as a pass. The screen-reader target is
not verified at all.

This record states what was measured, on what, and what was not measured. A
required check that could not run is recorded as incomplete. It is not a pass,
and it is not silently dropped.

See [the shared control standard](../development/shared-controls.md) for what the baseline
requires, and [ADR 0014](../adr/0014-shared-modules-own-control-behavior.md) for
who owns control behavior.

## The grouped Ticket list (issue #159, ADR 0058 and ADR 0059)

Status: the automated checks pass. The `Tab` axis cycle, each axis's Groups, the
flat `none` list, the fold by key and by mouse, the cursor at rest on a Group
header and every refusal there, the detail pane holding its ticket, the Group
order against the attention order, the counts on a header and on the Section
header, the header-only short frame, the Group header at the plane's minimum
width - where the marker column and a double-digit count with a held turn spend
the pane's whole budget, in the open and the folded frame, and again with a
three-digit count that costs more than the budget holds - the empty grouped
message, and the axis surviving a restart were measured through the real App
frame harness at fixed terminal sizes on a real state file with a fake command
runner and fake sources, in `test/ticket-grouping-frame.test.ts`. The durable
fact is measured in `test/state.test.ts` (the getter and setter round trip, the
default on a fresh file, the v20 to v21 step, and the absence of any fold
table), the derived Workflow state's name in the same file's projection walk,
and the shared mechanism's ownership in
`test/shared-control-architecture.test.ts`. The folded Group, the collapsed
Group's held count, and the cursor on a header are asserted on the gallery's own
`ticket-groups` example in `test/shared-gallery.test.ts`; the catalogue's hint
for every split axis, its refusal of the bar's hint at `none`, and its refusals
on a header in `test/controls.test.ts`; the axis control's and the fold's guide
rows in `test/key-guide.test.ts`; and the two rows' presence in the mode's own
Key guide frame in `test/app.test.ts`.

`bun run lint`, `bun run typecheck`, and one full `bun run test` ran on this
change with no other `bun test` process on the machine (load average 3.1, the
suite green at 2064 tests over 84 files, no skips). The
grouping frames were each confirmed red by deletion: keying the fold store on
one axis instead of the operator's own leaves "an axis visited twice comes back
with its own folds" red, reading the header fact outside the Ticket modes leaves
"a Group header under the Ticket cursor gives no other section a fold" red, and
handing the narrow header's budget a floor of one cell leaves "a Group header at
the minimum width drops its value before it wraps" red on a header that wrapped
its held count onto a second window row.

ADR 0060's Ignored ticket is recorded as sitting in no Group and counted by no
Group header. The ignore is not implemented on this branch, so nothing here
measures it; what the grouping leaves for it is a construction rather than a
gate: the axis slices the rows the list already shows, so a Ticket that leaves
those rows leaves every Group and every header count with no rule to write.

What was not measured: no terminal walk of the grouped list was run in Ghostty
or foot. The keyboard targets below were verified on the flat list before this
feature, and the grouping frames are automated only, so the grouped frame is
recorded as not walked by hand on a real terminal, and the screen-reader path is
unverified here as it is everywhere else in this record: a frame snapshot and a
key press say nothing about what a screen reader reads, and the Group header's
role is not announced by anything the plane controls.

## What is verified automatically

Every check below runs in `bun run lint`, `bun run typecheck`,
and `bun run test`.

| Requirement | Checked by | Result |
| --- | --- | --- |
| Text and Draft editing: caret, word movement, Home/End, Backspace/Delete, word delete, selection, replace-on-type, undo/redo | `test/shared-field-editing.test.ts`, `test/shared-controls.test.ts`, `test/handoff-frame.test.ts` | Passed |
| The Key guide's `Select all` key, Ctrl+A, selects the whole text in both field kinds, and F3 then copies the selection, reported as news on the Message line | `test/shared-controls.test.ts`, `test/consultation-launcher-editing.test.ts` | Passed |
| Ordinary and enhanced (Kitty keyboard protocol) key sequences mean the same operations | `test/shared-controls.test.ts` | Passed |
| Unicode, wide, and combined characters keep their cells and their caret | `test/shared-field-editing.test.ts` | Passed |
| Long text scrolls inside the field, and the visible caret is where the next edit lands | `test/shared-field-editing.test.ts`, `test/handoff-frame.test.ts` | Passed |
| Enter inserts a newline in a Draft field; a visible action submits | `test/consultation-launcher-editing.test.ts`, `test/consultation-frame.test.ts`, `test/executable-fields.test.ts` | Passed |
| Paste is text: it never submits a form and never runs an application control | `test/shared-field-editing.test.ts`, `test/executable-fields.test.ts` | Passed |
| A Context field refuses a non-digit paste as one operation, with and without selected text, keeps value, caret, and selection, and states why | `test/shared-controls.test.ts`, `test/tmux-fields.test.ts`, `test/executable-fields.test.ts` | Passed |
| A digit paste is taken, count validity and leading-zero folding stay in force | `test/shared-controls.test.ts`, `test/handoff-frame.test.ts`, `test/setting-resolution.test.ts`, `test/handoff.test.ts` | Passed |
| An oversized Draft field stays editable and states its size and limit | `test/consultation-launcher-editing.test.ts`, `test/consultation-launcher.test.ts` | Passed |
| Tab and Shift+Tab reach every field and action; arrows move the caret inside a Draft field | `test/consultation-launcher-editing.test.ts`, `test/consultation-launcher.test.ts` | Passed |
| A modal keeps focus inside itself; the base view takes no key while a form is open | `test/shared-field-editing.test.ts`, `test/override-panel.test.ts`, `test/handoff-frame.test.ts` | Passed |
| F1 opens the Key guide and F2 the Message view while editing, and neither loses the draft, caret, selection, or undo history | `test/consultation-launcher-editing.test.ts`, `test/key-guide.test.ts`, `test/message-line.test.ts` | Passed |
| Ctrl+C stays the emergency exit while a field holds a selection; F3 copies it and says what happened | `test/shared-field-editing.test.ts`, `test/action-bar.test.ts` | Passed |
| Auto copy: a drag release ends with the selected text on the clipboard, a click that did not drag copies nothing, a refused write warns on the Message line while a copy that takes is silent, a drag release over a list row leaves the row selection as the press set it, and the ended selection clears its own highlight | `test/auto-copy.test.ts` | Passed |
| Closing keeps the launcher's whole form, and it comes back on the same Repository and Consultation type; Discard is the only delete | `test/consultation-launcher-editing.test.ts` | Passed |
| A Response draft stays saved through the existing persistence path | `test/consultation-frame.test.ts`, `test/consultation.test.ts`, `test/state.test.ts` | Passed |
| Type-ahead shows its search, matches by substring, keeps an unmatched query with `no match`, edits with Backspace, clears with one key, and keeps query and value distinct | `test/shared-gallery.test.ts`, `test/handoff-frame.test.ts`, `test/override-panel.test.ts` | Passed |
| The Action bar and Key guide agree with dispatch, and field editing is named in the guide | `test/key-guide.test.ts`, `test/action-bar.test.ts`, `test/consultation-frame.test.ts` | Passed |
| Consultation list and Agent view navigation, response gating, recovery, history, close, delete, and refresh use the shared catalogue, and Enter opens the recovery surface each broken or stuck state needs (ADR 0038) | `test/controls.test.ts`, `test/consultation-frame.test.ts`, `test/shared-gallery.test.ts` | Passed |
| Consultation close is key `w` in both Consultation modes (#80): a closed record refuses readably, a `missing` or a `failed` one closes directly, a live Agent stops behind the shared panel, a `closing` one opens the panel with its retry and force-close, and the Ticket section's `w` stays its own Close in each section's guide and bar | `test/controls.test.ts`, `test/consultation-frame.test.ts`, `test/action-bar.test.ts`, `test/key-guide.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The Consultation close verifies the Agent's identity before it takes anything down (ADR 0044): the close's first herdr call is an `agent list` probe, a reused tab or pane id whose pane holds a bare shell or a foreign Agent retires the record with no command and its owned resources recorded as remaining, an unverified opening stays `closing` for a retry or a Force-close, an ambiguous name or an unreadable list refuses the cleanup as a recovery, a matched Agent that moved is followed and closed where it stands, and an unnamed herdr falls back to the stored session and then the stored pane | `test/consultation-operations.test.ts`, `test/consultation-frame.test.ts` | Passed |
| The Consultation detail reads the Agent's session record as its body (operator input, agent text, tool notes), capped, and keeps the Agent view and captured history as its fallbacks | `test/turn-log.test.ts`, `test/consultation-detail.test.ts`, `test/consultation-frame.test.ts` | Passed |
| The Consultation-only key `d` refuses in both Ticket base modes and in both Work queue modes with the section's own words, claims the key so nothing else answers it, and the guide and bar of each section that does not own it omits the control. `f` has two list owners now - the Ticket section's List filter and the Consultation section's History - so each section dispatches its own control there, and the Work queue, which owns neither, states the two owners' words in one sentence whichever candidate the catalogue reaches (ADR 0060) | `test/controls.test.ts`, `test/action-bar.test.ts`, `test/key-guide.test.ts`, `test/main-view-frame.test.ts`, `test/work-queue-frame.test.ts` | Passed |
| No refused key is hinted by the Action bar unless the Key guide names it, in every base mode of all three sections (the catalogue-wide guard that keeps the refusal, the guide, and the bar in step) | `test/controls.test.ts` | Passed |
| Goto in the Consultation base mode focuses the Agent pane while the pane is alive in the last poll and states its reason otherwise, and never changes the Consultation | `test/controls.test.ts`, `test/consultation-frame.test.ts` | Passed |
| Goto in the Ticket base modes (`g`) focuses the agent's pane on an in-flight ticket while the pane is alive in the last poll, on an `awaiting` ticket while the handoff recorded a pane, and states the Consultation's own refusal otherwise; it never moves the ticket's state, and the Decision modal's and Live view's Goto rows moved none | `test/controls.test.ts`, `test/live-view.test.ts`, `test/auto-mode.test.ts`, `test/domain.test.ts`, `test/state.test.ts` | Passed |
| The Work queue section dispatches its list, detail, order-move, pause, and removal from the shared catalogue; its list and detail modes name themselves in the Key guide and keep each section's keys in its own guide, the Consultation section's `d` and the two lists' `f` refused there in the owning sections' words and named in neither the queue's guide nor its bar; the Section stands on the Main view whatever the queue holds (ADR 0049), and the cursor crosses into it while it is expanded | `test/work-queue-frame.test.ts`, `test/key-guide.test.ts`, `test/controls.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The Work queue's detail names whose start a waiting row is - the operator's or the factory's auto top-up - so an automatic continuation route and the operator's own route of the same origin read apart on the pane (ADR 0051), and the Work header's depth counts the rows whatever asked | `test/work-queue-frame.test.ts` | Passed |
| The Consultation submit runs the Work queue's enqueue check ahead of any write: a type the config no longer names, and a type whose settings do not fit, refuse the ask with the reason on the Message line, leave no record and no queue row, and run no external step - no repository resolve, no clone, no herdr call - while the launcher keeps the operator's form (ADR 0049) | `test/consultation-operations.test.ts`, `test/consultation-frame.test.ts` | Passed |
| The queue pause holds the auto top-up's adds at the observation seam: auto mode on, the queue empty, an eligible ticket ready, and the paused cycle adds nothing; the resume adds the one item (ADR 0052) | `test/observation.test.ts` | Passed |
| The continuation and re-fired-skip walks' guard lists are measured guard by guard in auto mode, each with the route isolated from the cycle's other adds: the ticket open, the outcome re-fired, fired, auto-advancing, and written clean, the position standing open, offering the outcome's task, actionable, past the Same-type hold, and under its handoff limit (ADR 0051, stories 43 and 22). Each guard was confirmed by deletion: the source line removed leaves the suite red. Two facts the walk tests are not reached on their own and are recorded as such: `actionable` already carries the position's unfinished attempt and its non-open state (the projection builds it from both), and the queue's one-item-per-ticket rule is the cycle's own empty-queue gate, so a per-ticket test inside the walk cannot be reached. The `fired` and position-identity tests hold a damaged trace and no fixture writes one | `test/observation.test.ts` | Passed |
| An item the pickup dropped is reconsidered by the top-up every cycle the queue is empty, the restart included: the ask's start report clears the episode mark on every exit that ends the item without a start, and a restart that started keeps it until the ticket leaves in-flight. Story 24 holds whole, and ADR 0051 stands as written; both halves were confirmed by deletion (ADR 0051, story 24) | `test/observation.test.ts` | Passed |
| The Consultation's hard checks run at the Work queue's enqueue, as ADR 0049 writes them, and the start re-reads the same fit on the record it picked up; both moments are measured, and ADR 0049 stands as written | `test/consultation-operations.test.ts`, `test/consultation-frame.test.ts`, `test/handoff.test.ts` | Passed |
| The `p` key reports a state file that will not take the write instead of raising out of the key handler, the way the Auto-handoff mode's toggle does, and leaves the pause where it stood (ADR 0052) | `test/work-queue-frame.test.ts` | Passed |
| The Work queue's facts hold outside the surface that shows them: the queue and its order survive the state file closing and reopening, a start asked while the seats are full waits with its origin and captured choice (walked through the real decision modal), and the automatic adds wait there too, since every start enters the queue (ADR 0049), a removal ends the whole waiting start including the claim a pickup parked behind the held herdr seat, the cancel line states only the removal the module measured (nothing claimed for a row its pickup had already taken), the module says nothing on the line for a row the operator removed after its run reached herdr, a picked-up route records its decision on the turn it came from through the one helper the direct route shares, the observation's automatic restart and automatic route skip a ticket the queue already waits for, a pickup of a restarted or routed item whose ticket took its seat in the race that skip misses cancels the item and names the start on the line, and the observation cycle runs the pickup before the auto top-up against the one seat count - the pickup in both modes, the top-up in auto mode alone (ADR 0051), since the open dispatch the first version of this row named is retired | `test/state.test.ts`, `test/handoff-dispatch.test.ts`, `test/work-queue-frame.test.ts`, `test/observation.test.ts`, `test/parallel.test.ts` | Passed |
| Force-dispatch (issue #89, ADR 0034): Enter on a queue row starts the item over a full Parallel limit through the dispatch module's one seam - the claim re-runs every hard start check the pickup runs and skips only the cap, the seat count stands over the limit until the work settles, a failed claim or a failed start leaves the queue with the failure's warning and the ticket keeps its state, and the catalogue refuses the key while a Handoff runs or the queue is empty. A Consultation item runs the same key through its own pickup seam (issue #90): the item leaves the queue on every answer, the started line names the cap when the seat count stood over it, and the catalogue refuses the key for a Handoff item only while a Handoff runs - a Consultation start never parks on the herdr seat | `test/handoff-dispatch.test.ts`, `test/work-queue-frame.test.ts`, `test/consultation-frame.test.ts`, `test/controls.test.ts`, `test/key-guide.test.ts`, `test/shared-gallery.test.ts` | Passed by the automated suite. The frame is what the checks read: no screen-reader path was measured for the key, and the terminal walks above have not been re-run for it. |
| Close in the Ticket base modes (`w`) ends the selected ticket's work cycle behind the shared confirmation panel: it refuses an `open` ticket with its reason, opens the dialog with the body its own handoff's environment states on an in-flight or `awaiting` one, leaves everything unchanged on Cancel, ends an in-flight cycle with no completion trace, records the `closed` decision on an `awaiting` one, stops the agent through the Close cleanup, and records the leftover herdr refuses | `test/controls.test.ts`, `test/ticket-close.test.ts`, `test/domain.test.ts`, `test/state.test.ts`, `test/handoff-dispatch.test.ts`, `test/auto-mode.test.ts` | Passed |
| The ignore in the Ticket base modes (`i`, ADR 0060) writes the flag on the ticket identity in the state file and nothing to the source: the resting row leaves the list and the section's counts, the header carries the conditional `ignored` cell behind the held count and its bell, the row keeps its state badge and wears its own marker, the detail names the ignore, its moment, and the key that clears it, the same key takes the Ticket back, and the write refuses an `awaiting` Ticket, a held turn, and a missing Agent with the obligation's own words. The ignore hides a resting row and never a live one: an ignored Ticket with an Agent in flight keeps its row, its badge, its Parallel limit seat, and its flag, and the row goes back into the pile when its cycle ends. Every automatic start holds the Ticket out for as long as the flag stands - the Top-up's continuation, re-fired skip, restart, and open-ticket add - so a missing Agent takes no automatic Restart either, while a start the operator asks for by hand still runs, and the waiting start an ignore finds leaves with the row. The reads that resolve a Ticket by identity - the queue row's title, the queue's cancel line, an open panel, the Live view's pane read, a route's position, a confirmed override, the Consultation launcher's repository choices, and the live-checkout conflict name - take the projection before the list rule, so a Ticket nowhere in the list still names itself and keeps its screen. The List filter (`f`) cycles active, ignored, and all, opens on the active rows at every boot, keeps the cursor's Ticket when the new view still shows it, and says so from both Ticket panes' bar and guide; the section's counts and the held-count bell read the active view, so a cycle of `f` moves no count and rings no bell. The pile is the ledger of the operator's own acts: a Ticket that is ignored *and* covered by a fixing pull request that appeared later stands in the pile and in no other view, and the cycle reaches that row and clears it there. The gallery holds the ignore's flip, one bar and one line per refusal with the words read through the catalogue's own availability, and the filter's three hints | `test/ignored-ticket.test.ts`, `test/controls.test.ts`, `test/key-guide.test.ts`, `test/action-bar.test.ts`, `test/state.test.ts`, `test/observation.test.ts`, `test/section-header.test.ts`, `test/shared-gallery.test.ts` | Passed by the automated suite. The frame is what the checks read: no screen-reader path was measured for the key, and the terminal walks above have not been re-run for it. The held count's and the bell's place against a non-zero ignored count is measured on the row the header component paints and on the live frame at the widths where one cell must go; it is not measured on a herdr-inherited theme. |
| The confirmation panel dispatches the Ticket close's rows through the catalogue, and the gallery holds the dialog's states | `test/action-bar.test.ts`, `test/key-guide.test.ts`, `test/shared-gallery.test.ts` | Passed |
| Agent interaction mode exposes its configured exit control, preserves emergency exit, and forwards unclaimed input | `test/consultation-frame.test.ts` | Passed |
| The Consultation confirmation panel uses shared action selection and dispatch | `test/action-panel.test.ts`, `test/consultation-frame.test.ts` | Passed |
| The library's region module owns the Decision region's selection, wrap, auto-scroll, visible window, and range text; the compact range readout has one shared home behind the region's bar and the utility overlays' own windows; the region's selection, the body's scroll gate, and the one-row refusal ride the catalogue | `test/shared-region.test.ts`, `test/shared-control-architecture.test.ts`, `test/controls.test.ts`, `test/key-guide.test.ts`, `test/action-bar.test.ts`, `test/decision-modal.test.ts`, `test/live-view.test.ts` | Passed |
| The standalone theme's text and indicator pairs clear the measured contrast (the only contrast-checked theme; an inherited herdr theme is not contrast-checked, ADR 0024) | `test/shared-presentation.test.ts` | Passed |
| The no-color presentation strips color and keeps labels, the focus marker, and state words | `test/shared-presentation.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The spinner paints its named first frame beside its written word in the state-word tone, drives its own frames in the test renderer through the shared `useSpinnerFrame`, stands still on that hook's inactive flag, and the no-color presentation keeps its word and drops only its color | `test/shared-controls.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The Starting window (ADR 0030): a claim in flight or a `handed-off` ticket wears the face - the animated glyph with the written word `starting` - in the state badge slot of the list row and of the detail's state line, from the keypress, for every origin (manual, auto, workflow route, restart), and the `[handed-off]` badge is never drawn; a failed start ends the face and returns the row to its state, a turn that settles under a `handed-off` ticket ends it at the badge that state rests in, and the observation ends it at `[running]`; the failure markers (`blocked`, `missing`) and a crash remnant's recovery fact beat the face, and the detail states the marker's word in the line the face held; `NO_COLOR` keeps the written word in row and detail and drops only the color | `test/starting-face.test.ts`, `test/app.test.ts`, `test/handoff-frame.test.ts`, `test/live-view.test.ts`, `test/action-bar.test.ts`, `test/theme-frame.test.ts` | Passed by the automated suite. The animated frame is not something a frame snapshot verifies: the checks run on the written word beside any glyph of the face. The row and the detail drive the shared frame separately, so the two glyphs can stand on different frames for a moment; the word carries the fact. The terminal walks above have not been run for the face, and the suite has not been re-run on a herdr-inherited theme for it. |
| The overlay surface paints the theme's own `panel_bg` role, and the text the surface's own rows paint clears the measured contrast on the surface it landed on | `test/reserved-rows.test.ts`, `test/shared-gallery.test.ts`, `test/key-guide.test.ts`, `test/shared-presentation.test.ts` | Passed |
| The plane paints the Theme the environment resolves: the inherited herdr theme's colors on rows, borders, badges, and the Message line, a light theme painting the whole plane light, the fallback warning on an unknown name, the standalone theme outside herdr, and `reset` roles and `NO_COLOR` painting no color | `test/theme-resolver.test.ts`, `test/theme-source.test.ts`, `test/theme-frame.test.ts` | Passed |
| The gallery shows the states a theme change must keep: the inherited theme's swatches, the fallback warning, a light theme painting the shared controls' ink, the per-token `[theme.custom]` overrides, and the no-color presentation | `test/shared-gallery.test.ts` | Passed |
| Decorative animation and caret blinking are off by default, and no check depends on a blink or a timer | `test/shared-presentation.test.ts`, the frame suite's bounded waits | Passed |
| Small and narrow frames keep the focused control and the way out; below a usable size the surface states its size and how to leave | `test/reserved-rows.test.ts`, `test/handoff-frame.test.ts`, `test/consultation-frame.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The shared library is required: no screen builds its own field, names a renderer field, or hand-edits a draft string | `test/shared-control-architecture.test.ts` | Passed |
| The gallery's examples are the production modules | `test/shared-gallery.test.ts` | Passed |
| A control's written reason uses the width its surface names, and is cut to its own cells when the surface names none | `test/shared-controls.test.ts`, `test/override-panel.test.ts`, `test/shared-gallery.test.ts` | Passed |
| A row whose value cannot reach its Agent wears the warning tone and writes the Setting fit sentence under itself, at every width the panel renders at | `test/override-panel.test.ts`, `test/handoff-frame.test.ts` | Passed |
| A row that waits for the list its value would be judged against keeps that value in the tone of a setting it cannot confirm | `test/shared-controls.test.ts`, `test/handoff-frame.test.ts`, `test/shared-gallery.test.ts` | Passed |
| The override panel's state tones come from the shared palette, and the no-color presentation keeps a warning row's value and its whole sentence | `test/override-panel.test.ts` | Passed |

## Environment these checks ran in

| Part | Version |
| --- | --- |
| OS | Arch Linux, kernel 7.2.5-3-omarchy |
| Runtime | Bun 1.4.2 (the pinned minimum is 1.3.0, ADR 0035) |
| Renderer | OpenTUI `@opentui/core` 0.5.11, `@opentui/react` 0.5.11 |
| Test runner | `bun:test` (Bun 1.4.2), run through `bun run test` (`bun test --parallel --isolate`) |
| Multiplexer (tmux path) | tmux 3.7c |

## Required acceptance targets and their state

| Environment | Required checks | Result |
| --- | --- | --- |
| Linux with Ghostty | Keyboard and visual checks | **Verified** on Ghostty 1.3.1-arch2 under Hyprland 0.56.2 on this machine. All four gallery examples walked: typing, caret movement, selection shading, F3 copy (the terminal confirmed the clipboard), a paste refused as a whole with its reason, a taken paste, undo and redo, the F1 Key guide opening and closing, and Esc leaving the gallery. |
| Linux with foot | Keyboard and visual checks | **Verified** on foot 1.28.0: the same walk, with paste driven by foot's clipboard-paste key; the refused paste kept its value and stated why, the taken paste landed at the caret, the F1 Key guide opened and closed, and Esc left the gallery. `NO_COLOR` set on the same window: labels, the focus marker, and the state words survived with the colors off. **Not re-run** after the plane began inheriting the Theme from herdr (ADR 0024): the paint the walk measured was the fixed dark palette. |
| A light terminal with herdr's light theme | Visual checks | **Not verified under the theme mechanism.** The earlier check ran under the old `FACTORY_PRESENTATION=light` pin, which ADR 0024 removed: light is now a theme the plane inherits from herdr's config, and the base panes that half-migrated under the pin now paint the theme's roles. The suite checks the gallery's surface and every text it paints span by span, and a desktop re-walk on a light herdr theme is still to be recorded here. |
| A tmux path on Linux | Keyboard, paste, focus, and rendering checks | **Verified** by `test/tmux-fields.test.ts` on tmux 3.7c: the production gallery on a real pane, keys sent as terminal bytes, the screen read back with `capture-pane`. |
| Separate GNOME Terminal and Orca environment | Screen-reader operation | **Not verified.** Neither GNOME Terminal nor Orca is installed here, and the standard forbids changing an operator's desktop configuration as an unannounced setup step. No screen-reader claim is made anywhere in this repository. |

### Visual check procedure for Ghostty and foot

Run it on a machine with a desktop session, then record the versions and results
in this file. Do not mark the row verified from the automated suite.

1. `bun run gallery` and walk every example with `Tab`, the theme examples included.
2. In the `fields` example: type into the focused Context field, press Left,
   Right, Home, End, Shift+Arrow, Ctrl+Arrow, Ctrl+Backspace, Ctrl+Z, Ctrl+Y;
   paste `1e3` and then `42`; paste a long single line and a multi-line draft.
3. Check the caret's cell, the selection's shading, the box's borders, the label
   column, and the reason line under the field. Resize the window narrow and
   short, then back, and confirm the draft and caret survive.
4. Repeat steps 2 and 3 in the real screens: `e` on an open Ticket for the
   override panel, `c` for the Consultation launcher, and `Enter` on an awaiting
   Consultation for the response editor.
5. Check `?`/`F1` (Key guide), `F2` (Message view), `F3` (Copy selection), `Esc`,
   and `Ctrl+C`, and confirm the Action bar names only keys that did what it
   said.
6. Repeat with herdr's light theme active in the config (the plane inherits
   it on its next startup) and with the colors turned off (`NO_COLOR` set).

### Screen-reader procedure, not yet run

OpenTUI lists screen-reader support as future work, and Orca reads
AT-SPI-compatible applications, so this path must be measured rather than
inferred. A frame snapshot, raw PTY bytes, or a passing keyboard test proves
none of it.

1. On a GNOME session with Orca running, open GNOME Terminal and run
   `bun run gallery`, then the control plane itself.
2. For each field, ask Orca to read the focused control and confirm it states
   the field's label, its value, and the caret position; then edit and read
   again.
3. Select text by keyboard and read the selection; copy it with `F3` and paste
   it into another application to confirm what was copied.
4. Read a field's error line, a refused paste's reason, an unavailable action's
   reason, and a loading or empty state word.
5. Open and close the Key guide and the Message view from inside a field, and
   confirm Orca states the change of surface and, after the close, returns
   focus to the same field with the same caret and selection.
6. Watch a changing progress message and a Consultation state change, and
   confirm the operator learns of them without reading the screen.
7. Record the GNOME, GNOME Terminal, Orca, Node, and OpenTUI versions, and the
   result of each step, in this file.

If the renderer cannot give Orca any of this, stop and return for agreement on a
renderer change or an equivalent accessible interaction mode. Do not lower the
requirement to keyboard-only support, and do not claim the baseline complete.

## The gallery's `notes` example

The gallery's `notes` example - the written reason at the width the surface
names, and the waiting row's dim tone - joined the gallery earlier in this
branch's line of work. The terminal walks above were run before it existed:
they are recorded as not re-verified for that example, not as a pass for it.

## The inherited Theme (issue #55, ADR 0024)

The control plane now inherits the Theme from herdr. The pure resolver
(`src/components/shared/theme.ts`) and its machine seam (`src/theme-source.ts`)
are covered by `test/theme-resolver.test.ts` and `test/theme-source.test.ts`:
name normalization and aliases, `auto_switch` to `dark_name`, all 18 vendored
built-in definitions (recorded as taken from herdr 0.9.0), per-token custom
overrides including `reset`, a bad override dropping only its token, the
inside-herdr versus outside-herdr defaults, and the `catppuccin` fallback with
its warning. The app frame seam is covered by `test/theme-frame.test.ts`: the
real app paints the inherited theme's colors on rows, borders, badges, the
Message line, and an overlay surface; the fallback warning reaches the Message
line in the fallback theme's own severity color; the standalone theme stands
outside herdr; and `reset` roles and `NO_COLOR` paint no color.
`test/shared-presentation.test.ts` keeps the contrast floor for the standalone
theme and the no-color integrity, and `test/shared-gallery.test.ts` drives
the gallery's `theme`, `theme-fallback`, and `no-color` examples. The full
suite passed in green on this branch.

The recorded limits, stated rather than hidden:

- Inherited theme pairs are **not contrast-checked**. The operator picks a
  herdr theme for the terminal they run in, and the plane neither tests nor
  clamps it. The contrast check runs on the standalone theme alone: the
  vendored set is the plane's data, and no test contrast-checks it.
- Light `auto_switch` is not followed: the plane resolves the `dark_name`
  theme and never guesses the host appearance.
- The terminal walks above (Ghostty, foot) measured the fixed dark paint and
  have **not been re-run** on the theme-inherited paint, so they are recorded
  as not re-verified for it. The light-herdr-theme visual walk is new and
  unrun.

## The light presentation: the decision (superseded)

The light presentation was once a pin, not an automatic switch: reachable only
through `FACTORY_PRESENTATION=light`, gated because the base panes no shared
module owned still painted the fixed dark color system. ADR 0024 supersedes
that decision: the pin and the light/dark presentation concept are removed,
light is a theme the plane inherits from herdr's config, and the base panes
now paint the theme's roles. The recorded desktop check under the pin stands
as history, not as a pass for the theme mechanism.

## What the implementation still leaves open

The library, and every field, selector, search, form action, form focus route,
Consultation view, Agent interaction mode, and Consultation confirmation panel
the control plane owns, are wired to the shared Control catalogue, and every
surface - the base panes included - paints from the shared Theme module (ADR
0020). The remaining gaps: the screen-reader path has not been measured (see
above), the terminal walks have not been re-run on the theme-inherited paint
(see the inherited-Theme record above), and inherited herdr theme pairs are
not contrast-checked (limit recorded there).

## The merged Main view (PR 42)

The merged Main view keeps the Consultation launcher and the response editor
on these same shared modules, so the checks above cover the fields, choices,
actions, and focus routes those two surfaces now run. The section
architecture around them - the section headers, the pane switch, and the
Catalogue rows the Ticket and Consultation sections add - is covered by the
automatic suite, which passed in full on the merged branch. The terminal
walks above were not re-run on the merged Main view: they are recorded as
not re-verified for that view, not as a pass.

## The dual-list Main view (issue #49)

ADR 0019 replaces the accordion with two stacked list sections and one
context-dependent detail pane: `t` and `v` are gone, `x` toggles the section
under the cursor, the Consultation close moved to `z`, and up and down cross
the section boundary. The automatic suite covers the headers, the steady
counts, the collapse, and the cross-section navigation, and it passed in full
on this branch. The terminal walks above were not re-run on the dual-list Main
view: they are recorded as not re-verified for that view, not as a pass.

## The Session view in the Consultation detail (issue #67)

ADR 0025 reads the Agent's session record as the Consultation detail's body:
the operator's inputs, the agent's text, and the tool notes, in order, capped,
re-read on the detail's refresh while the Consultation is open, and read once
for the after-the-fact review of a closed Consultation. The record's rows sit
under the `Session view` border title; when the record cannot be read, the
older bodies remain the fallback under the `Agent view` title: the live pane
output for an open Consultation, the captured history for a closed one. The
Goto control in the Consultation base modes (`g`) focuses the Agent pane while
it is alive in the last poll and states its reason otherwise; it is a
navigation, and it never changes the Consultation. Its confirmation is a
result on the Message line, never a warning, and it names the workspace
herdr moved the view into: the Goto is the plane's one focus move, and a
focus request moves every attached client's view (ADR 0061).

The automatic suite covers the record's parsing and caps (`test/turn-log.test.ts`),
the body's selection and rows (`test/consultation-detail.test.ts`), Goto's
availability and dispatch (`test/controls.test.ts`), the four new gallery
examples a reviewer must see (`test/shared-gallery.test.ts`), and the two
end-to-end frame tests: a working detail that shows the record's rows and
focuses with `g` without touching the Consultation, and a closed Consultation
whose record is shown and whose Goto states its reason when the poll drops
the pane. It passed in full on this branch.

The terminal walks above were not re-run on the Session view's paint: they are
recorded as not re-verified for that body, not as a pass. The screen-reader
target remains unverified.

## The Consultation-only keys in the Ticket section (issue #85)

Keys `d` (Delete) and `f` (History) belong to the Consultation section. In
both Ticket base modes the keys still resolve, and the shared dispatch states
the refusal on the Message line in the catalogue's own words - "this control
is available only in the Consultation section", the mirror of the Ticket
section's refusal - and claims the key, so nothing else may answer it. The
Ticket guide omits both controls from every one of its sections, and the
Ticket bar hints neither key: the bar hints no key its guide omits. The
Consultation section's guide and bar keep both hints unchanged, and the keys
keep their Consultation meanings, including the closed-Consultation delete.

The section ownership is stated once per control in the catalogue
(`consultationSectionOnly`), and the refusal (availabilityFor), the guide
omission, and the bar omission all read it; no id list, and no inverted copy
of the same predicate. A catalogue-wide guard test walks every base mode and
fails if a refused key is hinted by the bar while the guide does not name it,
so the next Consultation-only key cannot refuse in the Ticket section and
still show up in its guide or bar.

The automatic suite covers the refusal and the key claim in both Ticket
modes, the untouched Consultation meanings, and the guard test itself
(`test/controls.test.ts`), the bar's omission (`test/action-bar.test.ts`),
the guide's rows and ranges (`test/key-guide.test.ts`), and the frame test
that presses `d` and `f` in the Ticket list and again in the Ticket detail,
checks the refusal on the Message line, and compares both sections' rows and
both list selections before and after every press, so the refusal is shown
to change nothing (`test/main-view-frame.test.ts`).

On the rebased catalogue (after ADR 0031 put a `w Close` row in the Ticket
guide) the counts were re-measured, not computed: the Ticket guide holds 54
rows at the full width where it held 56 with Delete and History present, the
scroll ladder walks 35 steps to the bottom row `36-54/54`, and the narrow
60x12 case holds 75 rows where it held 77. The guide screenshots need no
regeneration: neither section's Action bar changed, and the Key guide is not
screenshotted, so `test/screenshot-drift.test.ts` passes against the
committed images.
On this branch `bun run lint` and `bun run typecheck` pass, and
`test/controls.test.ts`, `test/action-bar.test.ts`, `test/key-guide.test.ts`,
`test/main-view-frame.test.ts`, and `test/screenshot-drift.test.ts` each pass
in isolation. The full `bun run test` passes on the rebased branch (1506 pass,
13 skip, 0 fail): the frame flakes issues #103 and #104 record did not show on
this run, and the 13 skips are the ones that record already holds.

The display rule the section asymmetry rests on - the Consultation guide
names a refused `e Override` dim, while the Ticket guide and bar omit the
refused `d` and `f` - is written down in the
[shared control standard](../development/shared-controls.md), so the next
contributor does not "fix" one direction to match the other.

The terminal walks were not re-run on the changed bar and guide rows: they
are recorded as not re-verified for this change, not as a pass. The
screen-reader target remains unverified.

## The Consultation-only keys in the Work queue (issue #85, ADR 0034)

The Work queue's two modes joined the catalogue's shared base modes, and with
them the Consultation section's `d` (Delete) and `f` (History) reached a queue
cursor: in the Work queue detail `d` resolved to the Consultation's Delete and
stated "only a closed Consultation can be deleted", a fact about a row the
queue's cursor can never hold, and both queue modes listed `d Delete` in the
Key guide's current-mode section beside the queue's own reorder keys.

The ownership rule that issue #85 built for the Ticket section now covers every
section that does not own a Consultation control: the marker reads the mode's
section, not one section's name. In both Work queue modes `d` and `f` state
"this control is available only in the Consultation section" and claim the key,
and the queue's guide and Action bar name neither control. A closed
Consultation elsewhere steals nothing, because the ownership decides the
refusal before the selected row does. (The queue's own `d Queue down` the first
version of this record described is gone: ADR 0049 retired the `u` and `d`
reorder keys, and `+` and `-` move the selected item now.)

The automatic suite covers the refusal, the guide omission, and the bar
omission in both queue modes, and extends the catalogue-wide guard walk to all
six base modes (`test/controls.test.ts`); the guide's current-mode rows, which
name the queue's own keys and neither Consultation row
(`test/key-guide.test.ts`); and the frame walk that boots the real app with two
waiting starts, presses `f` in the Work queue list and `d` in the Work queue
detail, reads the refusal on the Message line, and compares the queue's rows,
its order, its depth, its cursor, and its detail before and after each press,
so the refusal is shown to change nothing (`test/work-queue-frame.test.ts`).

The change touches no Action bar the operation images draw: the Work section's
bar loses the two hints it never had the right to show, the Ticket and
Consultation bars come out of it unchanged, and the Key guide is not
screenshotted, so `test/screenshot-drift.test.ts` re-runs clean on the
committed images. The terminal walks are not re-run for this change, and the
screen-reader target remains unverified.

## The Work queue's seat count on the held-turn frame (issue #87, ADR 0034)

The Parallel limit's combined count reaches every surface that shows it, and
the held-turn frame's mode line is one of them: it reads `auto: on 2/3 paused`
where it read `1/3` before a Consultation held a seat. When that change
landed, the frame was one of the checks issue #103 skipped, so the automated
run did not exercise the edited number and the case was run by hand once on
that head, with the skip lifted and the file run alone:
`bun test test/turn-end-cause-frame.test.ts --isolate`, one pass, 25
assertions, 0 fail, so the mode line showed the combined count with the held
turn and the seeded Consultation both in it.

Issue #103's fix lifted that skip, so the full-suite run now exercises the
mode line on every run: the hand measurement stands as history for the head
it measured, and the continuous guard for the number is the suite itself
(`test/turn-end-cause-frame.test.ts`), beside the active frames in
`test/auto-mode.test.ts` and `test/parallel.test.ts`.

## The Ticket section's Goto key (issue #82, ADR 0033)

ADR 0033 makes key `g` a base-mode control of the Ticket section, in both
base modes: it runs the same focus the Decision modal's and the Live view's
Goto rows run, confirms on the Message line with the workspace name, and
changes no record. It is available on an in-flight ticket whose agent is
alive in the last poll and on an `awaiting` ticket whose handoff recorded a
pane; elsewhere it refuses with the Consultation's own words. The state move
the modal Goto carried, `awaiting` back to `running`, is gone from every
Goto: the poll already makes that move when the agent works again, and the
badge stays true while the ticket rests.

The automatic suite covers the control's availability, refusal, and dispatch
(`test/controls.test.ts`), the gallery example a reviewer must see
(`test/shared-gallery.test.ts`), the Action bar's and the Key guide's rows
for the new control (`test/action-bar.test.ts`, `test/key-guide.test.ts`),
the domain and state machines without the `goto` decision
(`test/domain.test.ts`, `test/state.test.ts`), and the end-to-end frames: `g`
on an in-flight ticket focuses the pane and moves nothing
(`test/live-view.test.ts`), `g` on an `awaiting` ticket focuses the recorded
pane and leaves it `awaiting` (`test/auto-mode.test.ts`), and `g` on an
`open` ticket refuses on the Message line without focusing anything
(`test/live-view.test.ts`). The guide screenshots were regenerated on this
branch (`npm run screenshots`), and the drift check passed. The suite passed
in full on this branch.

The terminal walks were not re-run on the Action bar's and the Key guide's
new row: they are recorded as not re-verified for this control, not as a
pass. The screen-reader target remains unverified.

## The Ticket section's Close key (issue #83, ADR 0031)

ADR 0031 makes key `w` a base-mode control of the Ticket section, in both base
modes, on the key ADR 0032 freed. ADR 0037 later gave the same key to the
Consultation section's close, so `w` closes whichever section holds the cursor:
the catalogue resolves it per mode, and the Key guide of a Ticket pane lists the
Consultation close among the control-plane controls it catalogues on its own
terms, never as this mode's key (`test/controls.test.ts`). It refuses an `open`
ticket with its reason, and asks first on every state that has work behind it.
The shared confirmation panel states who is alive - the Agent working, the pane
herdr no longer lists, or the turn settled - and then what survives, read off
that ticket's own environment: the worktree checkout and the workspace behind
it, with a dirty checkout left standing as a leftover, or the live worktree's
tab alone with the checkout, the workspace, and the tabs beside it kept. The git
branch stays in every case, and the Cancel row states the same fact about the
pane that the body's first line states.

The confirmed answer is two closes with one cleanup. An `awaiting` ticket takes
the Decision modal's own close: the `closed` decision on its settled turn's
trace, then the Close cleanup - one function, so the modal's row and the key
cannot drift. An in-flight ticket ends its cycle through a state operation of
its own that writes no completion trace, because the turn never settled and no
cause, turn log, or message exists to record. Both wait their turn on the
shared environment seat, so a close that meets a Handoff of the same ticket
runs after it settles. The whole close suite measures the two cycle-end gates
reading the absent row as a cycle end that holds nothing and re-verifies
nothing, the way they read an abandon without a cause, and the Handoff limit
counting the closed cycle like any other. Both gates name the newest ended
cycle as `work_cycle - 1`, and a check pins the invariant that reading stands
on: the only statements that move a ticket's `work_cycle` are the two cycle ends
(`test/state.test.ts`).

The automatic suite covers the control's availability, refusal, and queue
(`test/controls.test.ts`), the dialog's facts (`test/ticket-close.test.ts`),
the state line and the durable close with its gates
(`test/domain.test.ts`, `test/state.test.ts`), the seat order and the leftover
fact through the dispatch interface (`test/handoff-dispatch.test.ts`), the
gallery's two dialog examples (`test/shared-gallery.test.ts`), the Action
bar's and the Key guide's rows for the new key (`test/action-bar.test.ts`,
`test/key-guide.test.ts`), and the end-to-end frames: the refusal on an open
ticket, the body and Cancel on both environments, the traceless close with its
cleanup, the refused cleanup's leftover, the awaiting close with its decision,
and the open dialog that lets go of its keys when the observation ends its cycle
from under it (`test/auto-mode.test.ts`). The Action bar's ladder and the Key
guide's row counts are re-measured on the rebased catalogue, where both sections
hold a Close at priority 50 in their own modes, and the close's frames wait on
the `missing` marker ADR 0030 puts before the Starting face. The guide
screenshots were regenerated on this branch (`bun run screenshots`), and the
drift check passed. The suite passed in full on this branch (1497 pass, 13 skip,
0 fail), with the checks issues #103 and #104 already record as skipped still
skipped.

The terminal walks were not re-run on the new key, its bar row, or the dialog:
they are recorded as not re-verified for this control, not as a pass. The
screen-reader target remains unverified.

## Enter's recovery meaning in the Consultation section (issue #84, ADR 0038)

ADR 0038 gives the Consultation section a third meaning of `Enter`: the key
opens the surface the selected record's state needs. A `working`, an
`awaiting-response`, and a blocked Consultation keep Interact, Respond, and
Interact. An `opening`, a `missing`, or a `failed` one opens the recovery panel,
whose rows the record's state names: Recover and Close on the interrupted
opening, Replace and Close on the record with no Agent. A `closing` one opens
the close panel that already carries its Retry and Force-close, and a `closed`
one refuses with the reason the close control already stated.

The automatic suite covers the resolution and the reasons
(`test/controls.test.ts`), the flows through the real application: `Enter`
opening the panel and each row running its own operation, the Replace row
carrying the durable recovery context onto the launcher and the link onto the
new record, the Close row taking the close path with its dialog for a live
Agent and without one for a record with none, and the closed refusal
(`test/consultation-frame.test.ts`), and the panel's three states drawn from
the production module in the gallery (`test/shared-gallery.test.ts`). The Key
guide names the recovery meaning of `Enter` in the Consultation section, and
the Action bar's row and reason follow the catalogue
(`test/key-guide.test.ts`, `test/main-view-frame.test.ts`).

The Action bar's ladder and the Key guide's row counts are re-measured on the
rebased catalogue, not computed: the guide now holds 55 rows at the full width
where PR #114 measured 54, its scroll ladder walks 36 steps to the bottom row
`37-55/55`, the narrow 60x12 case holds 79 rows where it held 75, and the
Control plane section lists `Enter Recovery` ahead of `Enter Respond` and
`Enter Interact`. The gallery's example list carries the three recovery states
beside the two Ticket Close dialogs (`test/shared-gallery.test.ts`). The guide
screenshots still match the app: the drift check in
`test/screenshot-drift.test.ts` passed on the merged catalogue, so no image was
redrawn. The suite passed in full on this branch:
`bun run lint`, `bun run typecheck`, and `bun run test` (1517 pass, 13 skip,
0 fail).

The terminal walks were not re-run for this control's Action bar and Key guide
row: they are recorded as not re-verified for it, not as a pass. The
screen-reader target remains unverified.

## The Work queue's rows join the recovery rows (issue #88, ADR 0034)

The queue's controls (the reorder pair, the removal, and the shared move and
scroll rows its detail reuses) and ADR 0038's `Enter Recovery` row now ride
the same catalogue. The counts are re-measured on this branch's merged
catalogue from real frames, not computed: the guide holds 55 rows at the full
width where PR #114 measured 54, its scroll ladder walks 36 steps to the
bottom row `37-55/55`, and the narrow 60x12 case holds 79 rows where it held
75 (`test/key-guide.test.ts`). The queue's own guide entries, mode names, and
refusals stand as recorded above.

## Enter force-dispatches a Work queue item over the cap (issue #89, ADR 0034)

Enter on a Work queue row is the force-dispatch: it starts the item now, even
when the Parallel limit is full. The seam is the dispatch module's own
`forceDispatchWorkQueueItem`: the claim crosses the one claim path the pickup
shares - the restart-or-route race check, the state gate, the claim's hard
checks, and the Starting window - and skips only the cap, which the module
now owns. The seat count stands over the limit until the work settles, the
way the mode line's `N/M` already reads the force-dispatched start against
the shared count.

A failure ends as a pickup failure with the one difference the operator asked
for: the item leaves the queue. A claim the dispatch refuses - the ticket no
longer holds the state its origin requires, its source is gone, or the ledger
is unclear - leaves the queue with the warning that names what stood in the
way, and a start that fails leaves the queue with the warning that names the
operation and the failure the handoff's own line carries. The ticket keeps
its state and its own failure surface in both cases. The success line states
only the fact the dispatch measured: over the cap when the cap was full at
the dispatch, the pickup's own words when a free seat stood.

The catalogue gates the key in the queue's list pane: a Handoff in flight
refuses with the Ticket section's own words, an empty queue refuses with the
queue's row keys' one reason, and a cleanup that holds the seat while a
Handoff does not lets it through - the module parks the claim, and the row
leaves when that parked start settles. The queue's own keys stay out of the
other sections' guides, so the Ticket guide's row counts stand where the
issue #88 record measured them: 55 rows at the full width and 79 rows in the
narrow 60x12 case (`test/key-guide.test.ts`). The queue's own guide gained
the Enter row with its note, the note flowing onto its continuation rows at
the widths the catalog wraps, the way every long note in the guide does.

The gallery's force-dispatch example holds the bar's states - the hint
available on an item, dimmed while a Handoff runs, and dimmed on an empty
queue - and the Message lines the refusals and the failure carry
(`test/shared-gallery.test.ts`). The module tests measure the seam's ends on
faked external operations: the start over a full cap, the start that fails
its first external step, and the claim the state refuses
(`test/handoff-dispatch.test.ts`). The frame tests walk the same three ends
through the real app flow: the start over a full cap with the seat count
standing over it at `2/1`, the start that meets a down herdr, and the claim
the state refuses (`test/work-queue-frame.test.ts`).

The terminal walks were not re-run for this key's Action bar and Key guide
row: they are recorded as not re-verified for it, not as a pass. The
screen-reader target remains unverified.

## The launcher queues a Consultation at a full Parallel limit (issue #90, ADR 0034)

The acceptance pass over the Consultation's entry into the Work queue, per
the shared control standard. The one shared order holds both kinds (ADR
0034): the queue's table keeps one row per start with the position as its
key, the Handoff's ticket identity and the Consultation's id in two unique
disjoint columns, and the order the operator sees is the order the pickup
walks. The launcher submit into a full cap creates the durable Consultation
record in `queued` state and its queue item in one write, holds no environment
and no agent until the pickup, and names the record and the queue it waits
in on the Message line. The pickup answers at the seat, not at the Agent:
the module's seam re-reads the Consultation type's settings from the config,
the record takes its seat in the atomic move from `queued` to `opening`, and
the opening pipeline runs on behind the answer. The item leaves the queue on
every answer: a started record holds its seat, a start that fails leaves a
terminal `failed` record with its reason on the Message line, and a record a
close or a delete out-waited the pickup leaves its row with the warning.

The surface reads the record the item names: the row carries the kind word
and the record's identity prefix, and the detail pane shows the ask, the
type, and the state - or the record gone in its place. The Consultation
section's own keys meet the `queued` record: `w` closes it without a dialog
and takes its item out of the queue, and Enter refuses it in the section's
words - its start is the Work queue's Enter. The Work queue's `Delete` takes
the item out and leaves the record in `queued` state with its ask: the
removal is the item's, not the record's (issue #91 lands the `unscheduled`
state and the Consultation section's schedule-back, start-over-the-cap, and
delete-record answers for it). The force-dispatch (issue #89) starts a
Consultation item over the cap through the same seam: the line names the
cap when the seat count stood over it at the key, and the catalogue refuses
the key for a Handoff item only while a Handoff runs.

The checks: `bun run lint` and `bun run typecheck` pass; the behavior suite
passes in full at a six-way parallel run (1606 pass, 13 skip, 0 fail on this
worktree; the 32-way parallel default flakes on timing on this machine, on
this branch and on a clean checkout of the base alike, so the scoped run is
the measured one). `bun run screenshots` redrew nothing. The gallery holds
the queue's row and detail states for the Consultation kind and the
force-dispatch's Consultation bar and line (`test/shared-gallery.test.ts`).
The frame tests walk the real app flow: the submit at the full cap, the
queued close, the pickup at the freed seat, the item removal, and the
force-dispatch over the cap with the seat count standing over it at `2/1`
(`test/consultation-frame.test.ts`, `test/work-queue-frame.test.ts`).

The screen-reader path is not verified. The terminal walks recorded for the
Work queue above have not been re-run for the Consultation item's row and
detail states: they are recorded as not re-verified for them, not as a pass.

## The aligned control surface (issues #80–#85)

The acceptance pass over the finished close and goto alignment, per the
shared control standard. The alignment gave the two sections the same
discipline on the same keys: the Consultation close moved to `w` with its
confirmation on a live Agent (#80), the leftover clear was removed while the
leftover stayed a fact herdr clears (#81), the Ticket Goto took `g` as pure
navigation (#82, ADR 0033), the Ticket Close took `w` with its confirmation
dialog (#83, ADR 0031), `Enter` gained its recovery meaning in the
Consultation section (#84, ADR 0038), and the Consultation-only keys in the
Ticket section learned to refuse in the section's own words (#85).

The full automated suite passed in full on this branch: lint, typecheck, and
the behavior suite, run through the package scripts, with 1554 pass, 13
skip, 0 fail - re-measured on this branch's merged catalogue, 37 more tests
than this pass first measured (1517), and the 13 skips are the ones this
record already holds as skipped. On the versions in the table below.

The gallery holds every state the alignment added or changed, drawn from the
production modules, and `test/shared-gallery.test.ts` walks each one:

- `ticket-goto`: the Ticket Goto available on an alive pane and refused
  otherwise, as two rows of the real Action bar.
- `ticket-close` and `ticket-close-live-worktree`: the Ticket Close dialog
  on an in-flight ticket (the worktree checkout goes, a dirty one stays)
  and on an `awaiting` ticket with the live worktree.
- `close-dialog-awaiting-response` beside `close-dialog-opening`,
  `close-dialog-working`, and `close-panel-closing`: the Consultation close
  dialog on an `awaiting-response` record, and the panel the `closing` one
  opens instead.
- `recovery-panel-opening`, `recovery-panel-missing`, and
  `recovery-panel-failed`: the Consultation recovery panels on their states.

The Action bar names only keys that did what they said, in every mode the
alignment touched, by the automated checks rather than by this pass's walk:
in the four base modes the catalogue-wide guard fails if a bar hint names a
key the mode refuses while its guide does not name it, and the per-mode
tests press each aligned key where dispatch claims it - `g` in the Ticket
and the Consultation panes, `w` in each section's own modes, and `Enter` on
the broken and stuck Consultations - and check the operation, while the
refused keys refuse on the Message line and leave every row unchanged
(`test/controls.test.ts`, `test/action-bar.test.ts`, `test/key-guide.test.ts`,
`test/main-view-frame.test.ts`, `test/live-view.test.ts`,
`test/auto-mode.test.ts`, `test/consultation-frame.test.ts`).

The required checks this pass could not run are recorded as incomplete, not
as a pass:

- The gallery walk over the new states was not performed in a terminal on
  this pass; the states stand verified by the automated gallery suite only.
  Incomplete against the gallery-walk criterion.
- The terminal walks (Ghostty, foot) were not re-run on the aligned Action
  bar and Key guide rows, so the visual confirmation that the bar names
  only keys that did what they said was not observed in a terminal on this
  pass. Incomplete for the alignment, in the standing sense recorded for
  the earlier changes.
- The light-herdr-theme visual walk remains unverified under the theme
  mechanism, and the screen-reader path remains unverified, as recorded
  above. No screen-reader claim is made for the alignment.

Measured on Arch Linux (kernel 7.2.5-3-omarchy), Bun 1.4.0, OpenTUI
`@opentui/core` 0.5.11 and `@opentui/react` 0.5.11, and tmux 3.7c.

## The native row-update corruption (OpenTUI, open as of 0.5.11)

A user report: streaming agent output in the Session view left stale text
overlapping the new rows, until a text selection cleared it. The reproduction
is `scripts/repro-tmux-live.ts`: it runs the real control plane inside tmux
(the byte path is a battle-tested VT) on the repo fixture, streams 120-249
cell lines from the fixture agent pane at 80 ms, captures the pane every
100 ms for 40 s, and checks that the visible stream lines stay a contiguous
run. It also records the exact bytes the app writes (tmux `pipe-pane`), so a
corrupted frame can be decoded and told apart from a transport or terminal
defect.

Measured on this machine (Bun 1.4.0, Linux x86-64, tmux 3.7a), 40 s runs:

- `@opentui/core` 0.5.9: 19-30 corrupted captures per run.
- `@opentui/core` 0.5.11: 0-30 corrupted captures per run; the corruption
  was measured present in 0.5.11 as well. The upgrade to 0.5.11 landed
  anyway: it is the newest release, and it carries fixes for the same
  failure family (a final frame lost behind backpressure, and split diffs
  misaligned after a resize).

The byte records place the fault in the renderer, not in the transport or
tmux: the app's own synchronized frames carry the corrupted rows. The
corruption takes two forms - a row's head truncated with the next row's
text merged into the same physical row, or a row truncated with the next
row or rows missing - and the corrupted content persists in the emitted
frames until the next content update overwrites it. In a streaming view the
next update heals it within a second; in a static view nothing re-sets the
row, so the artifact stands until any interaction forces a re-render. A text
selection does exactly that, which matches the user's report.

The failure signature matches the stale-buffer class of OpenTUI issue 1212
(fixed for the Node 26 adapter), but the owner-retention mechanism that fix
added is present in the Bun builds of both 0.5.9 and 0.5.11, and the
corruption still occurs: the remaining window is a separate native defect,
or a path the fix did not cover.

Local variations were measured, not reasoned: re-keying the body rows by
identity (40, 39, 9, 10 corrupted captures), toggling the plane's
force-full-repaint (29, 0, 10, 9, 29, 29), and pinning the wrapped row
strings to stable references (20, 30, 30, 29, 29) all landed inside or
above the 0.5.11 baseline range (0-30); none reduced the rate, and the
stable-reference change made the worst runs worse, so it was reverted.
Consolidating the body into one text element rendered wrong and was
reverted. The force-full-repaint in `src/factory.ts` stays: it is the
recorded workaround for the drift class of OpenTUI issue 1187.

This is recorded as an open upstream defect, not as a pass. The
`bun run lint`, `bun run typecheck`, and `bun test` checks pass in full on
0.5.11 (1554 pass, 13 skip, re-measured on this branch's merged catalogue).

## The Body pane, the Decision region, and the Live view's chrome (issues #121-#125, ADR 0039 and ADR 0040)

The written rules landed with the earlier links of the chain: the shared
control standard states the Body pane, the Decision region, their payment
order, and the one border-ink rule, and names the region module in the
library's module list; the architecture check refuses a surface that paints
decision rows without the library's region state, naming the offender by
file, with the shared chrome as the one stated exemption
(`test/shared-control-architecture.test.ts`); and the agent instructions
name the Live view's mode in the catalogue surface list. This link, issue
#125, carries the implementation the targets below measure.

What the implementation is: the region's selection, wrap, auto-scroll,
visible window, and range text are the library's region module
(`src/components/shared/region.ts`); the pane stands in the shared chrome's
`ModalSurface`, which takes a body of an optional above row, a bordered and
titled pane, and a below region; the decision surface computes the pane's
rows, its padding, and the region's visible rows in the stated payment
order (`decisionBodyLayout` in `decision-modal.ts`), and only then does the
surface stand down to the size message; the Live view renders on the same
surface, its stream sub-mode answering to the `live-view` catalogue mode
and its settled sub-mode to the `decision-modal` mode, with the border
re-titling `Live:` to `Decision:` on settle in place and no second pop-in.
The box carries no hint row of its own: the bar is the plane's only place
for keys, and it follows the mode the box is in.

What is measured automatically, on this branch:

- The chrome's box contract (issue #121): the `ModalSurface` interface takes
  its body as the typed body region with no raw children and no border color
  argument, the chrome paints the control ink's indicator for the box and the
  pane and only there, and no modal surface states a border color - the
  architecture check holds all three and names the offender by file
  (`test/shared-control-architecture.test.ts`).
- The nested border at the plane's declared minimum (40 by 27, the floor
  ADR 0049 raised with the Work queue's third permanent section): the box's
  border one cell in on every side, the pane's border and its padding inside
  the box's padding, the log's floor of three rows held inside the pane,
  the region's rows standing below the pane's bottom border with the
  selection on Close, and the keys dispatching in both regions - the region
  selection moving to Goto and the body jumping to the log's head
  (`test/decision-modal.test.ts`).
- The nested border with the pane's chrome yielded: at a low box the pane
  yields its padding before the log yields rows, keeps its border, and the
  scrollbar stays pinned to the body's last column inside the pane on full,
  short, and blank rows (`test/decision-modal.test.ts`).
- The Live view's shared chrome: the box's geometry above its Message line
  and bar, the bar's rows, the box without a hint row of its own, the Goto
  confirm that focuses the pane and closes the view and leaves the
  confirmation on the Message line, the hints following the mode, the
  re-title from `Live:` to `Decision:` on settle with the pane's title
  moving from `Agent view` to `Turn log` in the same frame, the stream's
  bottom pin and scroll keys, the stale note as the body's last line, and
  the auto-close turn that keeps streaming under the `Live:` border with no
  region rows (`test/live-view.test.ts`, `test/auto-mode.test.ts`).
- The catalogue: the `live-view` mode's keys beside its hints, the
  `live-goto` entry behind the Ticket Goto's pane gate, the
  `scroll-body` rename of `scroll-turn-log` (labeled `Scroll body`) serving
  both modal modes, and the Key guide opened from the Live view naming the
  mode and its controls, with the pane-not-alive reason on the Goto row
  (`test/key-guide.test.ts`, `test/live-view.test.ts`).
- The guide's pictures: the decision modal, the Live view's stream, and the
  settled Live view recaptured at the shared fixture, and verified by eye
  for the pane's border, title, and the region's rows (`test/screenshot-drift.test.ts`).

What the decision modal's own frames measure (issue #123), beside the
nested border above:

- The pinned floor with a short log: a body that fills none of the pane's
  window carries no thumb, the region stands directly under the pane's
  bottom border, and the box's border closes the floor below it - the
  region stays pinned whatever the body's length (`test/decision-modal.test.ts`).
- The capped region on a dense turn at a small terminal: the log keeps its
  floor of three rows with its thumb, the held cause and the transition's
  fact rows stand pinned above the region's action rows, the region shows
  the two action rows they fit and hides the rest, the bar states the
  window's range behind the selection's hint, and the window slides with
  the selection, the range following (`test/decision-modal.test.ts`).
- The pane's yield steps, walked by resizing the terminal over the open
  modal: the padding yields before the border, the border keeps and the log
  keeps its floor, only then does the log yield rows to the region's one
  row, and a box below even that stands down to the size message with the
  modal's own bar keeping the way out (`test/decision-modal.test.ts`).
- An empty Turn log: the reason stands as one row inside the pane, the pane
  keeps its border and title, the pane carries no thumb, and the scroll's
  key refuses with its reason on the Message line (`test/decision-modal.test.ts`).
- The gallery holds the reviewer's states: the capped region with the held
  cause above its rows, the short log's pinned floor, and the empty log's
  reason in its pane (`test/shared-gallery.test.ts`).

On first paint, the declared minimum (40 by 27) cannot reach the
stand-down: the box holds the rows the context row, the pane's
chrome, the log's floor, and the region's minimum of one row need, with room
over. The operator reaches it by resizing the terminal over the open
modal, which the yield steps above walk in the harness's frames. Nothing is
claimed for a walk that was not run.

What remains unverified:

- The terminal walks: the nested border and the re-title are measured in the
  harness's frames, not in a walked terminal, and the walks recorded earlier
  in this file have not been re-run on the pane. Not a pass.
- The screen-reader path: **remains unverified**, as recorded above. No
  screen-reader claim is made for the pane or the Live view's chrome.

The record's existing open items stand: the light-herdr-theme visual walk is
unrun, and the inherited herdr theme pairs are not contrast-checked.
Nothing in this section claims a pass for what was not measured.

## The library's region module and the shared range readout (issue #122)

The earlier link of the chain (issue #125) landed the region module and the
surfaces that consume it, and this link lands what issue #122 names that the
chain left behind: the compact range readout, first-last of total, had two
private computations - the region's own in `region.ts`, and one in the
utility overlays' `utility.ts` behind the Key guide's and the Message
view's scroll windows. It now has one home in the library's region module
(`rangeTextOf` in `src/components/shared/region.ts`), behind both the
region's range text and the overlays' own windows alike, and the private
copy in `utility.ts` is retired. The standard states the shared home in the
Body pane and Decision region section, and the architecture check refuses a
screen that computes the readout's shape outside the module
(`test/shared-control-architecture.test.ts`).

The region module's own behavior now stands measured on its own terms,
beside the flow tests that drive it through the surfaces:
`test/shared-region.test.ts` renders the module's state through the test
renderer and measures the selection's one-row-per-step move, its wrap at
both edges, the auto-scroll that slides the window only when a step would
leave it and holds it otherwise, the visible window, the range text behind
the window - absent where every row fits - and the confirm that runs the
selected row and returns the region to its first row with its window. The
readout's own cases - the window past the total, and the empty body's
`0-0/0` - are measured on the function itself.

The other acceptance criteria stand where the earlier links left them, and
this link re-measures them rather than re-implementing them: every surface
that shows decision rows (the decision modal, the Live view's settled
sub-mode, the Missing modal, and the confirmation panel) takes the region's
state from the module; the body's scroll control carries the shared name
(`scroll-body`, labeled `Scroll body`) and is gated on the facts, `bodyEmpty`
and `bodyScrollable`, with a stated reason, so the bar never hints a scroll
that cannot run; and the selection in a region that holds one row is refused
on the catalogue's `select-action` with its reason on the Message line
(`test/shared-control-architecture.test.ts`, `test/controls.test.ts`,
`test/decision-modal.test.ts`, `test/live-view.test.ts`,
`test/missing-modal.test.ts`, `test/action-panel.test.ts`).

`bun run lint`, `bun run typecheck`, and `bun run test` pass in full on this
branch (see the suite's numbers in the report of this change). The Key
guide's and the Message view's range readout is unchanged in shape: the
function it moved to computes the same string, and the guide's walk tests
(`test/key-guide.test.ts`) pass unmodified against it.

The terminal walks were not re-run for this change: the readout's paint is
the string the bar already stood, and the walks recorded earlier in this
file are not re-verified for it, not a pass. The screen-reader target
remains unverified.

## The queued badge of the Queue wait

A ticket whose manual start waits in the Work queue wears the `queued`
badge in the state badge's slot of its list row and of its detail's state
line, painted in the open role (CONTEXT.md, Queue wait). The badge is a
presentation fact, not a ticket state: the ticket keeps its `open` state, so
the section counts, the pickup gate, and the state file all keep it `open`,
and a removal, a failed pickup, or a pickup that starts the work gives the
row its open badge back by itself. The Work queue row keeps its origin cell
unchanged, and the Consultation's `queued` state is the separate fact it was
before this badge took the word in the Ticket section.

The automatic suite covers the badge in both surfaces, its open-role paint,
the unchanged open count, the open badge the ticket without a waiting start
keeps, the origin the queue row keeps, and the open badge the cancel gives
back (`test/work-queue-frame.test.ts`).

The badge's first cut of that test asserted its expected color through the
paint layer, which reads the test process's environment at the instant of the
assertion. The test files share one worker's environment and run beside
one another, and the no-color tests of the other files hold `NO_COLOR` while
they run, so a frame the app repaints inside that window wears no paint at
all: the expected color resolved `undefined`, and the frame the assertion
read could paint white. The environment the plane resolves from is now as
isolated as the standard states it is:

- `roleColor` in the shared harness resolves the standalone theme through
  the pure resolver instead of the paint layer, so an expected color never
  reads the environment (`unfitTones` resolves through it and kept its
  meaning).
- The full-suite script spreads the files across worker processes
  (`bun test --parallel --isolate`), so a `NO_COLOR` one file's test holds
  never reaches a frame another file's app paints.
- The theme isolation preloads into every test file
  (`bunfig.toml`, `[test]`), so the environment clears before every test of
  every file, the files that do not import it through the shared harness
  included.
- The no-color tests that left `NO_COLOR` set for the worker's remaining
  files delete it when they end: the two frame tests, the shared
  presentation's two no-color tests, and the override panel's.

The checks pass in full on this branch after the isolation, re-measured
on the tree merged with origin/main, which rebuilt the Work queue item
as a union the badge's predicate narrows to its handoff kind: `bun run
lint` and `bun run typecheck` pass, and `bun run test` passes in full
(1607 pass, 13 skip, 0 fail, twice in a row, about 38 s per run, on Bun
1.4.2). The 13 skips are the ones this record already holds as skipped,
issues #103 and #104. The direct run of the five files that share the
no-color tests and the badge's frame test passed four times in a row
(57 pass, 7 skip, 0 fail).

The terminal walks were not re-run on the queued badge: they are recorded as
not re-verified for this change, not as a pass. The screen-reader target
remains unverified.

## The Key guide's reason walk at 44 columns (issue #104)

The Key guide's 44-column reason walk timed out, and the skip was recorded
for issue #104. This branch removes the skip and re-measures the walk. The
guide is not the cause:

- The guide's scroll is right at 44 columns. The list holds 135 rows - the
  long reasons flow into the narrow reason column - the visible window is
  sixteen rows, and the bar's range indicator tracks the selection from the
  top of the list to its bottom, every step.
- The old walk overran its budget. It walked to each reason in turn, and it
  paid a full settle wait after every step. At the narrowest size the flowed
  reasons run the guide past a hundred rows, and the settle per step added
  to more than the test's allowance under load.

The walk now runs once from the top, and waits on the guide's own range
indicator advancing one row - the step's effect - instead of a full settle.
It reads the text of every window the walk shows, by the cells, not the
lines, because the narrow guide breaks a long word across rows, and it
searches the reasons in that collection of windows, the windows kept apart
by a separator, so a reason split between two windows never reads as whole.
The width check holds at every width, the 44 columns included: no row of
the guide is wider than the terminal.

The 44-column case runs in about 2.3 s on this machine, and the key guide
file passed five times in a row, once of them under a full-CPU load on all
cores. The full suite passed in full on this branch: `bun run lint` and
`bun run typecheck` pass, and `bun run test` passes (1748 pass, 12 skip,
0 fail, about 40 s, on Bun 1.4.2). The 12 skips are the ones this record
holds for issue #103.

The terminal walks were not re-run for this change: the Key guide's frame is
measured in the harness's frames, and the walks recorded earlier in this
file have not been re-run. The screen-reader target remains unverified.

## The twelve skipped frame and theme tests run in the full suite (issue #103)

The twelve skips of issue #103 lift on this branch. Nine of the twelve
flake from the theme environment one file held for the files beside it, and
the isolation main already carries closes that leak: the suite's per-file
processes, the preload that clears the theme environment and the cached
resolution before every test, and the `NO_COLOR` delete at the no-color
tests' end. The three that still failed, the theme-frame inheritance
checks, carried stale expectations: the harness' `roleColor` resolves the
standalone theme, so an inherited-theme frame was judged against the wrong
palette. The expectations now resolve the theme the test's config names
through the pure `resolveTheme` on the exact config text the test writes, the
same resolution the app's own path runs (`readHerdrConfig` plus
`resolveTheme(..., true)` in `src/theme-source.ts`), beside the literal hex
pins, so a theme table that moves still fails the test.

The two table rows that now stand `Passed` rest on a re-measurement of this
branch, rebased on origin/main: `bun run lint` and `bun run typecheck` pass,
and `bun run test` passes in full (1816 pass, 0 skip, 0 fail, 75 files,
twice in a row, about 38 s per run, on Bun 1.4.2, no concurrent `bun test`
on the machine), no test skipped.

## The close that moves no view (issue #158, ADR 0061)

The rule is one sentence: the control plane never moves herdr's view on its
own. It asks for no focus when it builds an environment, and it asks for none
when it ends one. Goto, key `g`, is the one focus move the plane makes, and
the operator makes it at the key.

The proof runs at two seams, and neither reaches a herdr session.

The frame seam drives the real screens and reads the command list the injected
runner recorded. `test/herdr-view-frame.test.ts` walks three of the four flows
the rule touches: the Close action on a worktree cycle, the Decision screen's
route close of the settled workspace, and the same close for an item that
waited in the Work queue and runs at the freed seat with no keypress beside
it. Each asserts the herdr work that ran and that no focus command ran with
it. The fourth flow, the Consultation close of a workspace, is proven at its
own frame seam: the close case in `test/consultation-frame.test.ts` walks the
confirmation panel through the real UI and asserts the same absence beside
the workspace, tab, and pane closes. Two more cases stand beside them: the
Close cleanup herdr refuses still reports its reason on the Message line and
still records the surviving environment as the ticket's leftover, and Goto
still asks herdr for the Agent's pane and still names the workspace the view
landed in. The handoff that follows a route still builds its environment with
every create stating its `--no-focus` and no create asking herdr for the view
with `--focus`.

The static seam is a declared dependency rule, not a behavior test
(`test/herdr-view-architecture.test.ts`). It scans the plane's own sources and
refuses a workspace focus command anywhere in them, refuses a tab or a pane
focus, allows an agent focus command only at the Goto seam in
`src/components/app.ts`, refuses a control-plane workspace id (the thread that
aimed the old compensating call is retired, so no new file can re-add the
move unnoticed), and refuses a herdr create whose argv does not state its
no-focus default. The create check reads each argv on its own: an assembled
argv must carry its `--no-focus` push between the declaration and the runner
call, so a file that says `--no-focus` once and creates elsewhere, or pushes
the flag after the call, fails it. An argv a function returns, or one passed
to the runner under another name, stays outside the scan; the file's header
states both limits. The ask side of the rule has no such limit: herdr's
`--focus` flag is refused as a token wherever a source carries it, which
covers `worktree open` and a `pane move --focus` beside a create, because
herdr applies its flags in argv order and a create that states its default
and then asks for focus moves every attached client. That refusal carries its
own positive control, a case that feeds the pattern the argv herdr takes and
the plane's real default, so an empty offender list cannot come from a
pattern that matches nothing. The re-ordered push was verified to turn the
check red in this rework, as was re-adding a `workspace focus` after a
worktree removal, which turns the frame case red. The `--focus` ask was
verified red on both create shapes: beside the `--no-focus` of an inline
workspace create, and pushed onto the assembled tab create after its default.
Each also turns the route and build frame cases red, because the fake runner
keys its answers on the exact argv a create sends.

The unit seams flipped rather than duplicated. The handoff module's Close
cleanup tests now name the absence, the dispatch rig test that used to require
the focus command requires its absence, and the Consultation operations
harness test does the same; each keeps its other assertions.

The herdr facts are read from herdr 0.9.1 source, and ADR 0061 names the two
places: `src/server/headless/client_views.rs`, where a public-socket request
moves every attached shell client only for `workspace.focus`, `tab.focus`,
`pane.focus`, `agent.focus`, and a create that asks for focus, and
`src/server/clients.rs`, where a client keeps its viewed workspace while that
workspace exists and falls back to the session focus only when it no longer
does. The behavior was read from that version; the plane has not been checked
against a later one.

**Incomplete: the live herdr walk.** The suite cannot observe a window, so no
test here claims what the operator sees. Two cases stay with the operator on
herdr 0.9.1, and neither has been run:

1. A Close cleanup of a worktree workspace while another workspace is viewed:
   herdr's view stays on the workspace the operator was reading, and the two-hop
   jump to the plane is gone.
2. A queued route item's close that lands while the view is elsewhere: the view
   stays where it was, with no keypress beside the close.

Until the operator runs them, this is evidence from the command seam and the
herdr source, not from a window. The one jump that survives by design is
herdr's own: when the plane closes the one workspace the client is viewing,
herdr moves that client, because the workspace it was looking at no longer
exists.

`bun run lint` and `bun run typecheck` pass. `bun run test` passes in full at
the pushed state: 2028 pass, 0 skip, 0 fail, 85 files, on Bun 1.4.2, with no
other `bun test` process on the machine. The screen-reader target remains
unverified, and the terminal walks recorded earlier in this file have not been
re-run.
