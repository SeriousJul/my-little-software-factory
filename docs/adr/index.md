---
title: Architecture decisions
description: The ADRs record what the project decided and why, in name order.
---

# Architecture decisions

The ADRs record what the project decided and why, in name order. A new
decision appends to the end of the list. Each entry is one decision; the
body states the context, the decision, and the consequences.

- [ADR 0001: Build the control plane on OpenTUI and TypeScript](./0001-open-tui-typescript.md)
- [ADR 0002: Handoffs run through herdr](./0002-handoffs-run-through-herdr.md)
- [ADR 0003: Fetch tickets through source adapters](./0003-ticket-source-adapters.md)
- [ADR 0004: SQLite owns factory state](./0004-sqlite-owns-factory-state.md)
- [ADR 0005: A work cycle ends at close](./0005-a-work-cycle-ends-at-close.md)
- [ADR 0006: The control plane polls herdr for agent state](./0006-the-control-plane-polls-herdr.md)
- [ADR 0007: Consultations are independent from Tickets](./0007-consultations-are-independent-from-tickets.md)
- [ADR 0008: The turn log comes from the agent's session record, not the terminal](./0008-turn-log-comes-from-the-session-record.md)
- [ADR 0009: Handoff settings resolve on their own chains](./0009-handoff-setting-resolution.md)
- [ADR 0010: Model discovery queries the agent's own CLI](./0010-model-discovery-through-the-agent-cli.md)
- [ADR 0011: The observation reclaims an agent that outlives its work cycle](./0011-the-observation-reclaims-an-agent-that-outlives-its-cycle.md)
- [ADR 0012: A leftover environment is a fact the operator can act on](./0012-a-leftover-environment-is-a-fact-the-operator-can-act-on.md)
- [ADR 0013: The Main view is one surface with two sections](./0013-the-main-view-is-one-surface-with-two-sections.md)
- [ADR 0014: Shared modules own control behavior](./0014-shared-modules-own-control-behavior.md)
- [ADR 0015: The turn end cause comes from the agent's session record](./0015-the-turn-end-cause-comes-from-the-session-record.md)
- [ADR 0016: The held turn gate and the Dispatch pause](./0016-the-held-turn-gate-and-the-dispatch-pause.md)
- [ADR 0017: A settle needs the turn to have started](./0017-a-settle-needs-the-turn-to-have-started.md)
- [ADR 0018: The documentation site builds from the docs folder with VitePress](./0018-the-documentation-site-builds-from-the-docs-folder-with-vitepress.md)
- [ADR 0019: The Main view holds two lists and one detail pane](./0019-the-main-view-holds-two-lists-and-one-detail-pane.md)
- [ADR 0020: The control plane publishes from a version tag with a short alias package](./0020-the-control-plane-publishes-from-a-version-tag-with-a-short-alias-package.md)
- [ADR 0021: A parallel seat is held before herdr lists the agent](./0021-a-parallel-seat-is-held-before-herdr-lists-the-agent.md)
- [ADR 0022: The ticket priority is a fact of the ticket identity](./0022-the-ticket-priority-is-a-fact-of-the-ticket-identity.md)
- [ADR 0023: A pull request inherits priority through the issues it closes](./0023-a-pull-request-inherits-priority-through-the-issues-it-closes.md)
- [ADR 0024: The control plane inherits the Theme from herdr](./0024-the-control-plane-inherits-the-theme-from-herdr.md)
- [ADR 0025: The Consultation detail presents the Agent's session record](./0025-the-consultation-detail-presents-the-agent-session-record.md)
- [ADR 0026: Auto-handoff holds a completed task type](./0026-auto-handoff-holds-a-completed-task-type.md)
- [ADR 0027: The plane owns the workflow machine and its label transitions](./0027-the-plane-owns-the-workflow-machine-and-label-transitions.md)
- [ADR 0028: The homepage hero is a real herdr capture](./0028-the-homepage-hero-is-a-real-herdr-capture.md)
- [ADR 0029: Security tickets synthesize severity as labels](./0029-security-tickets-synthesize-severity-as-labels.md)
- [ADR 0030: A starting ticket wears a spinner in place of its state badge](./0030-a-starting-ticket-wears-a-spinner-in-place-of-its-state-badge.md)
- [ADR 0031: A work cycle can close while the agent is still working](./0031-a-work-cycle-can-close-while-the-agent-is-still-working.md)
- [ADR 0032: The leftover environment is a fact; its cleanup lives in herdr](./0032-the-leftover-environment-is-a-fact-its-cleanup-lives-in-herdr.md)
- [ADR 0033: Goto is navigation in both sections](./0033-goto-is-navigation-in-both-sections.md)
- [ADR 0034: The Parallel limit counts Consultations and the Work queue holds the rest](./0034-the-parallel-limit-counts-consultations-and-the-work-queue-holds-the-rest.md)
- [ADR 0035: The control plane runs on Bun](./0035-the-control-plane-runs-on-bun.md)
- [ADR 0036: The Auto-handoff mode is factory state, not a config setting](./0036-the-auto-handoff-mode-is-factory-state.md)
- [ADR 0037: The Consultation close takes w and confirms on a live Agent](./0037-the-consultation-close-takes-w-and-confirms-on-a-live-agent.md)
- [ADR 0038: Enter answers a Consultation with the surface its state needs](./0038-enter-answers-a-consultation-with-the-surface-its-state-needs.md)
