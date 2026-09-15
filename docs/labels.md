# Ticket labels

The control plane reads labels as source facts, and it writes them through
the transitions of the [workflow machine](adr/0027-the-plane-owns-the-workflow-machine-and-label-transitions.md).
After a transition, the label set matches the machine's spec, whatever
labels the agents or humans wrote before. The agents no longer write
workflow labels: the task templates carry no label instructions. A human
label write stands until the next transition.

| Label | Meaning |
| --- | --- |
| `ready-for-agent` | An open GitHub issue is ready for implementation or another configured task. |
| `blocked` | The item is not ready for handoff. The default GitHub sources exclude it. |
| `ready-for-review` | A non-draft pull request is ready for review. |
| `ready-to-ship` | A non-draft pull request passed review with a score that reached the review transition's configured threshold (90 in the default machine). It is ready to be squash-merged. |
| `needs-work` | A pull request needs rework. This takes priority over `ready-for-review` and can apply to a draft. A failed merge of a `ready-to-ship` pull request lands here. |
