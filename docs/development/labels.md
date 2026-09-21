# Ticket labels

The control plane reads labels as source facts, and it writes them through
the transitions of the [workflow machine](../adr/0027-the-plane-owns-the-workflow-machine-and-label-transitions.md).
After a transition, the label set matches the machine's spec, whatever
labels the agents or humans wrote before. The agents no longer write
workflow labels: the task templates carry no label instructions. A human
label write stands until the next transition.

| Label | Meaning |
| --- | --- |
| `ready-for-agent` | An open GitHub issue is ready for implementation or another configured task. No transition writes it, so the plane neither adds nor removes it: it is a rank and an operator's signal, not a gate. |
| `blocked` | The item is not ready for handoff. The default GitHub sources exclude it, and the machine owns no `blocked` fact, so a write of it is the operator's. A native `blocked by` link to an open issue excludes the issue the same way, whatever its labels. The app never sees the issue. A closed blocking issue unblocks it. |
| `ready-for-review` | A non-draft pull request is ready for review. |
| `ready-to-ship` | A non-draft pull request passed review with a score that reached the review transition's configured threshold (90 in the default machine). It is ready to be squash-merged. |
| `needs-work` | A pull request needs rework. This takes priority over `ready-for-review` and can apply to a draft. A blocked merge of a `ready-to-ship` pull request lands here. |

A pull request that carries none of these labels is on the machine's parking
state: the default source lists it, because that is how the implement
transition reaches the pull request the agent just opened, and the plane
suggests nothing for it until a transition or a human labels it.

A label a state match names but no transition writes is a scoping label the
operator owns: the fire leaves it on the surface, so a state may gate on a
label the machine never touches, such as a `labels-all = ["factory"]` filter
that keeps the machine to one project's items.

## Creating the machine's labels

The plane writes its labels with `gh issue edit` and `gh pr edit`, and GitHub
refuses a write of a label the repository does not have: a fire that names a
missing label fails the whole write, records the failure on the turn's trace,
and routes nothing from it. Create the labels your machine writes before the
first fire can succeed. The default machine writes `ready-for-review`,
`ready-to-ship`, and `needs-work` on pull requests; `ready-for-agent` and
`blocked` stand on the source side and the plane never writes them in the
default machine. Create them in the repository's labels page, or with `gh label
create <name> --repo <owner>/<name>` for each one your states or transitions
name.
