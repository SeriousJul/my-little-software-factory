# The Main view is one surface with two sections

Status: accepted
Date: 2026-09-13
Superseded in part by ADR 0018: the decisions that one expanded section owns both list and detail, and that `t` and `v` switch sections, no longer hold. The Main surface, the single Message line, the single Action bar, the shared control catalogue, and the Consultation header's attention facts survive.

The control plane ran two fullscreen main views, a Tickets view and a Consultation view, switched with `t` and `v`, each with its own bottom lines, and the Consultation side never reached the control catalogue (issue #9). We decided to merge them into one Main view holding two accordion sections: the expanded section keeps its list pane and detail pane, the collapsed one shrinks to a header row, and `t`, `v`, or a header click expand a section. The Consultation section's header carries its attention facts, its controls join the catalogue under the new `consultation-list` and `consultation-detail` base modes, and its messages become Message facts. A Consultation that needs the operator must not hide behind a view switch, and the glossary's one Message line and one Action bar finally exist as one each.

## Considered options

- Keep the two fullscreen views with a view switch. Consultation attention stays hidden behind a keypress, and the second message and action system keeps running.
- One list pane with collapsible Tickets and Consultations groups sharing one detail pane. Collapsing hides only the rows, but each side loses its own master-detail layout.

## Consequences

- Both sections keep their list selection and detail scroll while collapsed; a re-expand shows the same place.
- The free-standing attention line and the Consultation status line disappear: attention facts live on the Consultation section's header row, and Consultation progress, notices, warnings, and errors ride the Message line.
- No key letter changes: Consultation keys keep their letters and gain catalogue availability, the Action bar, and the Key guide.
- The Main frame owns two header rows, so its minimum useful size rises with them: 40 columns by 9 rows is the shortest terminal that holds both headers, one real pane row, the Message line, and the Action bar. Below it the compact frame drops the headers with the panes.
- The Agent terminal and the response editor join the interaction mode set, so the Action bar and the Key guide state the keys those surfaces actually accept: the configured exit key, and Send and Keep draft.
