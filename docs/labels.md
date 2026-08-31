# Ticket labels

The control plane reads labels. It never creates, removes, or changes them.

| Label | Meaning |
| --- | --- |
| `ready-for-agent` | An open GitHub issue is ready for implementation or another configured task. |
| `blocked` | The item is not ready for handoff. The default GitHub sources exclude it. |
| `ready-for-review` | A non-draft pull request is ready for review. |
| `needs-work` | A pull request needs rework. This takes priority over `ready-for-review` and can apply to a draft. |
