# ADR 0007: Consultations are independent from Tickets

Status: accepted
Date: 2026-09-01

## Context

The operator needs to start interactive Agent work from free text, such as a `grill-with-docs` discussion. This work has no external Ticket and can require several rounds of operator input. A synthetic Ticket would invent source facts and a Work cycle, while attachment to the selected Ticket would make unrelated work affect that Ticket's lifecycle.

## Decision

A Consultation is durable, first-class work that is independent of Tickets. It has its own type, state, history, attention, and recovery behavior, while it shares Agent types, Environments, Repository resolution, and herdr polling (ADR 0006) with Handoffs.

## Consequences

Consultations use a separate TUI view and durable state instead of appearing in the Ticket list. Starting or closing one never changes Ticket state, and manual Consultations do not consume the auto-handoff Parallel limit.
