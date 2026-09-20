# Ticket labels

The control plane reads labels as source facts, and it writes them through
the transitions of the [workflow machine](adr/0027-the-plane-owns-the-workflow-machine-and-label-transitions.md).
After a transition, the label set matches the machine's spec, whatever
labels the agents or humans wrote before. The agents no longer write
workflow labels: the task templates carry no label instructions. A human
label write stands until the next transition.

| Label | Meaning |
| --- | --- |
| `ready-for-agent` | An open GitHub issue is ready for implementation or another configured task. The plane writes it only where a state's facts name it; the default machine suggests `implement` for an unlabeled issue, so this label is a rank and an operator's signal, not a gate. |
| `blocked` | The item is not ready for handoff. The default GitHub sources exclude it, and the machine owns no `blocked` fact, so a write of it is the operator's. |
| `ready-for-review` | A non-draft pull request is ready for review. |
| `ready-to-ship` | A non-draft pull request passed review with a score that reached the review transition's configured threshold (90 in the default machine). It is ready to be squash-merged. |
| `needs-work` | A pull request needs rework. This takes priority over `ready-for-review` and can apply to a draft. A blocked merge of a `ready-to-ship` pull request lands here. |

A pull request that carries none of these labels is on the machine's parking
state: the default source lists it, because that is how the implement
transition reaches the pull request the agent just opened, and the plane
suggests nothing for it until a transition or a human labels it.
