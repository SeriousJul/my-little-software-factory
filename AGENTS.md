# Control-plane contributor instructions

## Shared controls

- Read [CONTEXT.md](CONTEXT.md) for domain terms before changing control behavior.
- Follow [the shared control standard](docs/shared-controls.md) and
  [ADR 0014](docs/adr/0014-shared-modules-own-control-behavior.md) for all controls
  owned by the control plane.
- Use and extend shared modules. Do not add a separate screen-specific field,
  focus implementation, or key system. Keep domain validation, draft storage,
  and Agent operations outside the shared control modules.
- The shared-library migration is pending. Build missing behavior at the shared
  module interface, not as another local implementation. The standard specifies
  the required runnable gallery; do not claim that a gallery command exists
  before it is implemented and documented there.
- Start bug fixes with a reproduction through the real application flow. Use
  isolated test state and fake external operations, not live Agent work.
- Check `npm run lint`, `npm run typecheck`, and `npm test` for implementation
  changes, plus the applicable acceptance checks in the standard.
- Frame snapshots and keyboard tests do not establish screen-reader support.
  Record tested versions and results. A skipped required check is not a pass.
- Update current-behavior documentation as migrations land. Keep implementation
  rules in the standard and architecture decisions in ADRs, not in the glossary.
