# The contributor push gate and the plane's own pushes

Status: the failure, the bypass at the git level, and the argv each plane flow
sends were measured on 2026-10-09. One row is incomplete: no Handoff ran through
the real application with the gate red. A skipped required check is not a pass,
and it is not silently dropped.

See [ADR 0127](../adr/0127-the-plane-pushes-its-own-branches-outside-the-contributor-pre-push-hook.md)
for the decision and [the quality gate](../development/quality-gate.md) for the
hook's rules.

## What it was measured on

| Piece | Value |
| --- | --- |
| Head | `6e78174a`, plus the change this record belongs to |
| git | `git version 2.55.0` |
| bun | `1.4.2` |
| Hook active | `core.hooksPath = scripts/git-hooks` in the Shared checkout, and through it in every worktree of the repository |
| Remote | `https://github.com/SeriousJul/my-little-software-factory.git` |

## The failure, as it was reported

| Item | Result |
| --- | --- |
| The operator's warning | `Warning: queued handoff for "Multiple merge requested for a given PR" was not run: pushing the factory branch factory/352-multiple-merge-requested-for-a-given-pr failed: error: failed to push some refs to '...'`. Recorded in `config/.factory-development.log` at `2026-10-09T05:05:16.465Z`, and four times before it for two tickets |
| The hook's reason, which the operator never saw | `pre-push: bun run typecheck failed`, from `scripts/screen-font.ts(33,46): error TS7016: Could not find a declaration file for module 'fontkit'` |
| Why the reason was hidden | `failureLine` in `src/lines.ts` keeps the first line a tool marks `error:` or `fatal:`; the hook writes unmarked lines |
| The trigger | `@types/fontkit` landed in `6dff8d75` on 2026-10-08; this checkout's `node_modules` last installed on 2026-09-19 |

## The loop, and what it answered

The loop is `/tmp/repro-push.sh`. Its two load-bearing commands, so a reviewer
can re-run it without the script:

```sh
git -C <Shared checkout> branch -f factory/000-push-loop-probe origin/main
git -C <Shared checkout> push --dry-run origin factory/000-push-loop-probe
```

It is the handoff's own push shape: `git -C <Shared checkout> push origin <branch>`.
`--dry-run` keeps the remote unwritten while the installed hook still runs.

| Run | Verdict |
| --- | --- |
| The loop, before any change | RED, exit 1, in 4 s. Its last line is the operator's line: `error: failed to push some refs to '...'` |
| The same push with `--no-verify --dry-run` | GREEN, exit 0: `* [new branch] factory/000-push-loop-probe -> factory/000-push-loop-probe`. The remote held no such branch, and none was created |
| The loop after `bun install` installed `@types/fontkit` (`bun.lock` unchanged) | GREEN, exit 0, in 1.5 s. This is the repair of the trigger, not of the rule |
| `bun run lint` in a herdr worktree that holds no `node_modules` | Exit 127, `biome: command not found`. The hook refuses a push made from such a worktree |

## The bypass, at the git level

The loop is `/tmp/bypass-loop.sh`. It plants `src/tmp-push-bypass-probe.ts`
carrying `export const probe: number = "this is not a number";` in the Shared
checkout, so the hook goes red for the same class of reason, then asks git the
two questions the plane now answers differently. Both pushes are `--dry-run`.
The probe file and the probe branch were removed after the run.

```sh
git -C <Shared checkout> push --dry-run origin factory/000-push-loop-probe
git -C <Shared checkout> push --dry-run --no-verify origin factory/000-push-loop-probe
```

| Run | Verdict |
| --- | --- |
| A. `git push --dry-run origin <branch>`, the argv the plane used to send | RED, exit 1: `pre-push: bun run typecheck failed`, `pre-push: the push is refused`, `error: failed to push some refs to '...'` |
| B. `git push --dry-run --no-verify origin <branch>`, the argv the plane sends now | GREEN, exit 0: `* [new branch] factory/000-push-loop-probe -> factory/000-push-loop-probe`. No `pre-push:` line appears: the hook never ran |

## The argv, at the unit layer

| Item | Result |
| --- | --- |
| `bun test test/handoff.test.ts test/repo-init.test.ts test/git-push-architecture.test.ts` before the source change | 8 handoff failures, 2 Repository init failures, 1 architecture failure. The behavior tests read the flag from `BYPASS_CONTRIBUTOR_PUSH_HOOK`, so they went red on the argv, not on a wording |
| The full suite on the first round after the source change | 3228 pass, 1 fail. The failure was `test/auto-handoff-chain.test.ts`, which pinned the old argv in its own words rather than reading the constant. That is a third seam, found by the full run and not by the three files above |
| The same run after that assertion read the constant | 3229 pass, 0 fail, 16,639 expect calls, 146 files, 40.45 s |
| The architecture check | It refuses a `"git"` push argv in `src` whose file does not name the constant, and it asserts the scanned set holds `src/handoff.ts` and `src/repo-init.ts`, so it cannot pass by scanning nothing |

## What was not measured

| Item | Status |
| --- | --- |
| A real Handoff through the control plane, with the Shared checkout's typecheck red, against the real remote | Incomplete. It needs a live herdr session and a real branch push to `SeriousJul/my-little-software-factory`. The two rows above cover the git level and the argv level; nothing here covers the whole path through the TUI |
| A Repository init against a real repository | Incomplete, for the same reason |
| Whether the Agent's own pushes from a fresh worktree still fail on the hook | Not changed by this decision, and not measured as a flow. The `bun run lint` exit 127 above is the only measurement, and it stands as a known condition of the contributor gate |
