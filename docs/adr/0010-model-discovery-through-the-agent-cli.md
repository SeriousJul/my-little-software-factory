# ADR 0010: Model discovery queries the agent's own CLI

Status: accepted
Date: 2026-09-02

## Context

ADR 0009 resolves model and thinking level per handoff, but the factory cannot see which models an agent offers: model names are not portable across agent kinds, and a bad value dies inside the agent. The control plane is documented as agent-agnostic: it talks to herdr, git, and the GitHub CLI, never to the agent runtime itself.

## Decision

The command runner gains a model list query. For the pi kind it runs the agent's own CLI (`pi --list-models`) and reads the models the runtime reports as available; the runtime lists only usable models, so provider auth is already applied. The list serves three places: startup validation of the config's model values that name a determinate agent (the model each Task profile resolves to, which carries the `default-model` leg of its chain, and each Consultation type's model; the rest are checked at handoff time), the override panel (the Model row offers the selected agent's list), and the setting fit check at handoff time (an unfit model or thinking level fails the handoff with a readable reason before the agent starts). When no list can be fetched, the check is skipped and the agent's own rejection stands.

Thinking levels form one shared standard set (off, minimal, low, medium, high, xhigh, max). Each agent type declares the non-empty subset it supports, and free-text levels are retired.

## Considered alternatives

- Declare the model list in the config file, like `thinking-values`. Rejected: it drifts from reality as models ship, vanish, or lose auth, and the config would certify models the agent no longer offers.
- A declarative list-models command per agent type in the config. Rejected: only one kind has a list command today. The runner maps the kind to the CLI, and a declarative layer can follow when a second kind needs it.
- Check fit only at handoff time, as ADR 0009 had it. Rejected: a config error should be seen at startup, not mid-ticket, and the override panel needs the list regardless.

## Consequences

- The control plane now talks to the agent runtime directly, not only through herdr. The command runner stays the single egress, and the tests fake it.
- The runner is agent-kind aware by design. An unknown kind fails with a reason, and every consumer degrades: no list means a free-text Model row and a skipped fit check.
- The `pi --list-models` table shape is a pinned contract on the installed pi version. A layout change degrades to the no-list path with a warning, not a crash.
- A handoff that would have started and died inside the agent now fails in the factory with a readable reason, and the ticket stays open. This refines ADR 0009's "checked by the agent itself": the factory pre-checks when a list is available, and the agent's rejection still stands when it is not.
- A provider without auth reads as an unknown model, because the runtime lists only usable models. The startup error hints at checking auth.
- A Model list value is one argument cell, end to end. The parser refuses a row whose value carries whitespace, and the start command substitutes a setting value inside its own template token instead of splitting the substituted string. A model can therefore never become an argument plus a stray positional the agent reads as its model.
- The query carries its own short timeout rather than the handoff's ten-minute budget, because it runs before the first frame at boot, on every override panel open, and inside the observation cycle. A hung agent CLI degrades to the no-list path in seconds; the free-text Model row and the skipped model check are that path.
