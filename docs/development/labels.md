---
title: Ticket labels
description: The labels the workflow machine reads and writes, and the labels the operator uses.
---

# Ticket labels

The control plane reads labels as source facts, and it writes them through
the transitions of the [workflow machine](../adr/0027-the-plane-owns-the-workflow-machine-and-label-transitions.md).
After a transition, the label set matches the machine's spec, whatever
labels the agents or humans wrote before. The agents no longer write
workflow labels: the task prompts carry no label instructions. A human
label write stands until the next transition.

| Label | Meaning |
| --- | --- |
| `ready-for-agent` | An open GitHub issue is ready for implementation or another configured task. No transition writes it, so the plane neither adds nor removes it: it is a rank and an operator's signal, not a gate. |
| `blocked` | The item is not ready for handoff. The default GitHub sources exclude it, and the machine owns no `blocked` fact, so a write of it is the operator's. A native `blocked by` link to an open issue excludes the issue the same way, whatever its labels. The app never sees the issue. A closed blocking issue unblocks it. |
| `ready-for-review` | A non-draft pull request is ready for review. |
| `ready-to-ship` | A non-draft pull request passed review with a score that reached the review transition's configured threshold (90 in the default machine). It is ready for the plane's merge: the plane runs the merge as a plane action without an agent (ADR 0068), with the method the merge task type names (squash in the default machine). |
| `needs-work` | A pull request needs rework. This takes priority over `ready-for-review` and can apply to a draft. A blocked merge of a `ready-to-ship` pull request lands here. |
| `ready-for-spec` | An open GitHub issue needs a specification before the work is worth implementing. No transition writes it: the operator applies it to put the ticket on the analyze position, and the analyze agent applies `ready-for-agent` when the specification settles (ADR 0085, ADR 0086). The analyze type carries Operator-decides, so auto-handoff mode never starts that interview by itself: the operator's own handoff opens it (ADR 0117). |
| `bug` | An open GitHub issue is a bug: the repository's own triage writes it, and the shipped machine reads it as a fact, not as an order. The machine gates its diagnosis position on it and offers the `diagnose` task type (ADR 0116). No transition writes it, so the plane neither adds nor removes it, and the state order keeps the operator's stronger label ahead of it: a ticket carrying `ready-for-agent` or `ready-for-spec` rests there and is never offered a diagnosis. |
| `needs-info` | The triage vocabulary's information ask. No state gates on it and no transition writes it, so the machine never touches it. It is the one label the `diagnose` template's agent applies - on the skill's honest stop, when no red-capable loop stands - under ADR 0086's rule that an agent writes only the operator-owned labels its template names, and no other label, ever. |

A pull request that carries none of these labels is on the machine's parking
state: the default source lists it, because that is how the implement
transition reaches the pull request the agent just opened, and the plane
suggests nothing for it until a transition or a human labels it.

A label a state match names but no transition writes is a scoping label the
operator owns: the fire leaves it on the surface, so a state may gate on a
label the machine never touches, such as a `labels-all = ["factory"]` filter
that keeps the machine to one project's items. The Repository init creates the
gates the config names - a `labels-any` or `labels-all` label of any state -
because the machine reaches a gate only when the repository holds the label
(ADR 0115). A `labels-none` label, and a label no state and no transition
names, stay the operator's own to create.

## Making a repository factory-ready

The plane writes its labels with `gh issue edit` and `gh pr edit`, and GitHub
refuses a write of a label the repository does not have: a fire that names a
missing label fails the whole write, records the failure on the turn's trace,
and routes nothing from it. The labels a repository needs stand in its
repository's label set before the first fire can succeed.

The Repository init makes one repository factory-ready in one confirmed act
(ADR 0075, the gates and the feeds by ADR 0115): it creates the missing labels,
writes the convention files and the Agent skills block, and registers the
repository's sources - all generated deterministically from the factory's own
settings, with no agent. The labels it creates are the labels the machine
names: every label a transition writes, every label a state match gates on,
and the five canonical triage labels, `blocked` aside. It registers one issues
feed per label the machine gates issues on, because GitHub search cannot union
two `label:` qualifiers in one query, and one pull request feed with no filter.
In the
Ticket list, group by repository and press `i` on the repository's Group
header: the panel shows what the act will change, and confirming runs it. The
act pushes to the remote default branch through a throwaway worktree, so the
operator's checkout is never moved or dirtied.

A repository the factory has never seen stands in no Group, so the `i` path
cannot reach it. The select list closes that gap (ADR 0082): press `o` in the
main view. The list reads the operator's GitHub account and their
organizations' repositories on the ambient `gh` credentials, in one read, and
filters as the operator types. Enter on a row resolves the repository's local
checkout from the `repos` table or the conventional path and opens the same
confirmation panel. A repository without a local checkout is refused with the
path the act needs; the plane never clones. Several repositories at once: mark
their rows with `Tab`, and Enter runs the queue - one confirmation panel per
repository, in list order (ADR 0083).

`blocked` stands on the source side and the plane never writes it, so the init
never creates it. If you create labels by hand instead, use the repository's
labels page or `gh label create <name> --repo <owner>/<name>` for each one your
states or transitions name.
