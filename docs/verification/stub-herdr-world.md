# The Stub herdr world verification

Status: the world module and its suite pass on the unit layer. The suite
measures the world's answers to the plane's own command shapes, its stateful
transitions, its refusals for the commands it does not hold, its recording
shape, and the closed surface. The migration has moved the checkout
verification and all nine files that held a local copy of it onto the world;
the last of them, the auto-mode suite, moved with the per-test rework of its
standings and its GitHub pins (issue #375). The
Consultation launch then stood on the world, and the Agent interaction's text
and key sends reached the world's own pane, so the tests read what the pane
received from its send records instead of the commands that carried the
sends. Since then, the plane-boot migration (issue #366) re-landed seven of
those eight suites - the Action bar, the Consultation frame, the Handoff
frame, the Key guide, the Live view, the Message line, and the Starting face
- on the pin table: they now boot from the one total record on the Seeded
  plane, and their herdr and git answers come from the fake command runner's
  pins again. The Consultation operations and the Agent input queue stand on
  the world: their launch, send, conflict, and failure flows all run over it,
and their move onto the world is complete (issue #374). The seven suites'
move onto the world is recorded as incomplete below. The scoped Stryker
campaign over the Handoff dispatch and the observation has run on this
branch (issue #377): the campaign's host resolves the vendored typescript
shim
([ADR 0137](../adr/0137-the-mutation-campaign-host-runs-the-vendored-typescript-shim.md)),
and the two modules' mutation score stands measured.

The answer-shape tracing ran on 2026-10-14 against a live herdr 0.8.2
binary: the herdr JSON answers and the herdr refusal envelope are traced to
recorded herdr 0.8.2 answers, the git answers are traced to recorded git
2.55.0 answers, and every drift between a world answer and its recorded
answer is recorded below. The shapes that could not be traced stand
unverified in the table at the end of the tracing section, so the claim
stops at what was measured. A check that could not run is recorded as
incomplete. It is not a pass, and it is not silently dropped.

See [ADR 0132](../adr/0132-the-stub-herdr-world-answers-herdr-and-git-from-one-standing-world.md)
for the decision, [issue #361](https://github.com/SeriousJul/my-little-software-factory/issues/361)
for the requirement, [issue #376](https://github.com/SeriousJul/my-little-software-factory/issues/376)
for the tracing step, and [test/herdr-world.ts](../../test/herdr-world.ts) for
the module.

## What it was measured on

| Piece | Value |
| --- | --- |
| Runtime, host and test children both | Bun 1.4.2 (Linux x64) |
| Test layer | `bun test` on the unit layer: an in-memory world, the real production readers (the handoff, the observation, the consultation operations) driven over the world, and no desktop control |
| World module | [test/herdr-world.ts](../../test/herdr-world.ts), one `stubHerdrWorld` factory and its `StubHerdrWorld` surface |
| Herdr version the shapes name | 0.8.2, the version the plane's readers were written against |
| The Stryker host of the scoped campaign | Stryker core 10.0.0 on Bun 1.4.2, resolving the vendored typescript shim staged under its own `node_modules` before the run ([ADR 0137](../adr/0137-the-mutation-campaign-host-runs-the-vendored-typescript-shim.md)); the typescript 7.0.2 this repository declares stands untouched |
| The tracing's herdr binary | herdr 0.8.2, the `herdr-linux-x86_64` asset of the `v0.8.2` GitHub release of `herdrdev/herdr`, run as an isolated server with its own socket path and its own home, so the operator's live herdr session was never touched |
| The tracing's agent | the real pi 1.2.0, started by `herdr agent start --kind pi` in a pane of the isolated server; the pane's environment carried the operator's pi front door (`PI_PROVIDER` and `PI_MODEL`) |
| The tracing's git world | a scratch bare origin and a clone of it, with `origin/HEAD` at `origin/main` and a remote-only `feature` branch; git 2.55.0 |
| The tracing's date | 2026-10-14 |

## What was verified

| Requirement | How it was checked | Result |
| --- | --- | --- |
| A world description stands a checkout | `test/herdr-world.test.ts` ("the checkout side"): the description names the path, clone URL, default branch, and branches, and the checkout answers the git pair the plane's verification reads | Passed |
| A create adds to the world, a close removes from it | "the worktree side", "the live side", "the Agent side": a `worktree create`, `tab create`, `workspace create`, and `agent start` stand their entities, and a later `worktree remove`, `tab close`, `workspace close`, and `pane close` remove them, each close removing the Agents its panes held and cascading an empty tab and workspace | Passed |
| A close of what the world does not hold is refused with herdr's own code | the same blocks: a close of a workspace, tab, or pane the world never made answers the herdr error envelope with its code, and the plane's reader takes the refusal unchanged | Passed |
| The plane reads the refusal codes it reads | the blocks assert the codes the handoff and the observation read: `worktree_not_found`, `agent_name_taken`, `agent_pane_busy`, `tab_not_found`, `workspace_not_found`, and `worktree_remove_failed` | Passed |
| The held `agent wait` is the one exception to the refusal rule | "the Agent side": a wait for an Agent the world holds not at a settle state holds instead of answering, a `setAgentStatus` move to a settle state releases it with code zero, a wait for an Agent already at a settle state answers at once, and a wait for a target the world does not hold is refused | Passed |
| The recording keeps the fake runner's shape | "the recording": `commands()`, `settledCommands()`, `peakConcurrency()`, the raw `calls`, the `hold`/`release`, the `raise`, and the `set`/`setSequence` sequence all answer the way the fake command runner answers, so the gate and delay wrappers compose over the world unchanged | Passed |
| The closed surface stays closed | "the closed surface": every herdr and git command shape the plane builds is driven against a healthy world and meets no refusal; a shape the world never answers and a command the plane starts sending both fail there | Passed |
| The gate and delay wrappers compose over the world | the wrappers take a `CommandRunner`, and the world satisfies it; the suites that gate and delay a handoff run over the world without change | Passed |
| The checkout verification moves off the local builder | the nine files that held a local `stubCheckout` (the Action bar, the Consultation frame, the Consultation operations, the Handoff frame, the Key guide, the Live view, the Message line, the Starting face, and the auto-mode suite) now state the checkout as a world and their local builders are deleted | Passed |
| The Agent interaction's text and key sends are answered by the world | the Agent input queue's send tests and the Consultation frame's interaction test stand the world's own pane: the sends reach it, and the tests read them from `sentTextFor` and `sentKeysFor` instead of the recorded commands | Passed |
| The mutation score of the Handoff dispatch and the observation stands measured | The scoped Stryker campaign over `src/handoff.ts`, `src/handoff-dispatch.ts`, and `src/observation.ts` ran on 2026-10-13 on this branch's head, and re-ran on the head rebased onto the Seeded plane (#378), on the campaign's host resolving the vendored typescript shim ([ADR 0137](../adr/0137-the-mutation-campaign-host-runs-the-vendored-typescript-shim.md)) that issue #377's fix stages under the Stryker core's own `node_modules`. The crash that blocked the campaign stands recorded here: Stryker core 10.0.0's TypeScript preprocessor reads `parseConfigFileTextToJson` from the `typescript` package, and the typescript 7.0.2 this repository declares does not expose it, so the host died at the campaign's first step with `ts.parseConfigFileTextToJson is not a function`, before a mutant was measured; scoping the campaign to `src/handoff.ts` did not avoid it, because the preprocessor runs before the scope is applied, and no campaign, scoped or full, could start | 76.73 percent on the head the campaign measured (the pushed head adds #391's frame-rig rework, which changes the suite the campaign runs): of 4,835 mutants, 3,701 killed, 8 timed out, 1 runtime error counted with the killed, 919 survived, and 206 with no coverage, so 3,710 of 4,835; per file, `handoff.ts` 80.97 percent, `handoff-dispatch.ts` 76.96 percent, and `observation.ts` 72.19 percent. On the tree before the rebase the same scope read 76.69 percent; the [mutation-testing record](mutation-testing.md) holds the full breakdown |
| The herdr JSON answers trace to a recorded herdr 0.8.2 answer | the tracing section below: every herdr command shape the plane builds ran against the isolated herdr 0.8.2 server, the real answers were recorded, and each world answer was compared to them. The plane-read fields of every recorded answer stand in the world's answer, and the drifts that remain are recorded with their plane impact | Passed, with the recorded drifts below |
| The herdr refusal envelope and its codes trace to a recorded herdr 0.8.2 answer | the same run: every refusal the plane reads came back from 0.8.2 with the world's code, and the `agent_name_taken` message the plane parses out its holder from stands in the recorded message | Passed, with the recorded drifts below |
| The git answers trace to a recorded git answer | the tracing section below: every git command shape the plane builds ran against real git 2.55.0 on the scratch world, the real answers were recorded, and each world answer was compared to them. Herdr answers no git command, so the git family is traced to git, not to herdr | Passed, with the recorded drifts below |

## The answer-shape tracing (complete, drifts recorded)

The ADR requires every answer shape the world produces to be traced to a
recorded real herdr answer, with the herdr version named, and every shape
inferred from the plane's own reader recorded as unverified. The tracing ran
on 2026-10-14:

1. The isolated herdr 0.8.2 server stood up with its own socket path and its
   own home, and its panes launched the real pi 1.2.0 through the operator's
   pi front door. The operator's live herdr session was never touched.
2. A scratch git world stood beside it: a bare origin and a clone, with
   `origin/HEAD` at `origin/main` and a remote-only `feature/trace-shape`
   branch.
3. Every herdr command shape the plane builds ran against the server, and
   every git command shape the plane builds ran against real git 2.55.0, with
   the plane's exact argv. The exits, the stdout, and the stderr of every
   run were recorded.
4. Each world answer was compared to its recorded answer. The recorded
   answers stand in the tables below, abridged to the shape: the envelope,
   the fields the plane reads, and the fields the world answers. The full
   raw transcript of the run was scratch and is not kept beside the record.

### The herdr JSON answers

The recorded 0.8.2 answers carry an `id` (`cli:<command>`) beside the
`result` of every command, and a `type` in most results. The world's
answers carry neither, except the `id` of its `worktree list`. The plane
reads no `id` and no `type`, so the omission is a shape drift without a
plane impact. The recorded ids of the entities are `w1`, `w1:t1`, and
`w1:p1`; the world names its own `ws-1`, `tab-1`, and `pane-1`. The plane
treats the ids as opaque, so the naming is a shape drift without a plane
impact.

| Command the plane builds | The recorded herdr 0.8.2 answer | The world's answer | Verdict |
| --- | --- | --- | --- |
| `workspace create --cwd <checkout> --no-focus` | code 0: `{"id":"cli:workspace:create","result":{"type":"workspace_created","workspace":{"workspace_id":"w1","label":"checkout","focused":false,...},"tab":{"tab_id":"w1:t1",...},"root_pane":{"pane_id":"w1:p1","cwd":...,...}}}` | code 0: `{"result":{"workspace":{"workspace_id"},"tab":{"tab_id"},"root_pane":{"pane_id"}}}` | Matched on the fields the plane reads. Drift: the world omits the `id`, the `type`, and the extra fields, and it names its ids `ws-N` instead of `wN` |
| `workspace list` | code 0: `{"id":"cli:workspace:list","result":{"type":"workspace_list","workspaces":[{"workspace_id":"w1","label":"checkout","focused":true,...}]}}`. A workspace entry stands a `worktree` section (`{"checkout_path":...,"is_linked_worktree":...}`) once herdr has resolved the workspace's checkout: the section is absent at once after a create and stands in a later list. A workspace on the source checkout names the checkout itself as its `checkout_path` | code 0: `{"result":{"workspaces":[{"workspace_id","focused","worktree":{"checkout_path"}}]}}` | Matched on the fields the plane reads (`workspace_id`, `worktree.checkout_path`). Drift: the world always stands a `worktree` section, where 0.8.2 stands it only after it has resolved the checkout |
| `workspace get <ws>` | code 0: `{"id":"cli:workspace:get","result":{"type":"workspace_info","workspace":{"workspace_id":"w1","label":"checkout","focused":true,...}}}` | code 0: `{"result":{"type":"workspace_info","workspace":{"focused","label","workspace_id"}}}` | Matched. The plane reads `result.workspace.label`, and the recorded answer stands it. The world's `type` field matches the record |
| `tab create --workspace <ws> [--cwd <path>] --no-focus` | code 0: `{"id":"cli:tab:create","result":{"type":"tab_created","tab":{"tab_id":"w1:t2",...},"root_pane":{"pane_id":"w1:p2",...}}}` for both the `--cwd` form and the form without one | code 0: `{"result":{"tab":{"tab_id"},"root_pane":{"pane_id"}}}` | Matched on the fields the plane reads. Drift: the world omits the `id` and the `type` |
| `tab list --workspace <ws>` | code 0: `{"id":"cli:tab:list","result":{"type":"tab_list","tabs":[{"tab_id":"w1:t1","workspace_id":"w1",...}]}}` | code 0: `{"result":{"tabs":[{"tab_id"}]}}` | Matched on the fields the plane reads |
| `pane list --workspace <ws>` | code 0: `{"id":"cli:pane:list","result":{"type":"pane_list","panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","cwd":...,...}]}}` | code 0: `{"result":{"panes":[{"pane_id","tab_id"}]}}` | Matched on the fields the plane reads |
| `pane send-text <pane> <text>` | code 0, no stdout, no stderr | code 0, no stdout, no stderr | Matched |
| `pane send-keys <pane> <key>` | code 0, no stdout, no stderr, for every key in the plane's semantic set: `up`, `down`, `left`, `right`, `enter`, `escape`, `backspace`, `tab`, `f1` to `f12`, and `ctrl+<letter>`. 0.8.2 refuses `home`, `end`, `pageup`, and `pagedown` with code 1 and `invalid_key`, "unsupported key <key>" | code 0 for every key, including `home`, `end`, `pageup`, and `pagedown` | **Drift**: 0.8.2 refuses the four keys the plane's semantic set holds. The plane shows the operator an "Agent interaction failed" error on those keys, and the world hides it. See the drift table |
| `workspace close <ws>` | code 0: `{"id":"cli:workspace:close","result":{"type":"ok"}}`. The recorded close of the only workspace of a checkout removed the workspace, its tabs, its panes, and the Agent standing in them; the later `workspace list` stood the empty list, and `agent list` stood no agents | code 0, no stdout, the same removals | Matched on the code and the stateful removals. Drift: the world omits the `{"result":{"type":"ok"}}` envelope |
| `pane close <pane>` | code 0: `{"id":"cli:pane:close","result":{"type":"ok"}}`. The recorded close of a workspace's only pane took the pane, its empty tab, and the empty workspace with it; the later `workspace list` stood the empty list | code 0, no stdout, the same removals | Matched on the code and the cascade. Drift: the world omits the envelope |
| `tab close <tab>` | code 0: `{"id":"cli:tab:close","result":{"type":"ok"}}`. The recorded close of a tab left the workspace standing on its other tabs, and a close of the last tab removes the empty workspace | code 0, no stdout, the same removals | Matched on the code and the cascade. Drift: the world omits the envelope |
| `agent start <name> --kind <kind> --pane <pane>` | code 0: `{"id":"cli:agent:start","result":{"agent":{"name":"trace-agent","agent":"pi","agent_status":"idle","pane_id":"w1:p2","tab_id":"w1:t2","workspace_id":"w1","cwd":...,"state_change_seq":1,"interactive_ready":true,...},"argv":["pi"],"type":"agent_started"}}` | code 0: `{"result":{"agent":{"name","status":"idle"}}}` | Matched on the code. The plane reads no field of the start's answer. Drift: the world names the state `status`, where 0.8.2 names it `agent_status`, and the world omits the `type` and the `argv` |
| `agent list` | code 0: `{"id":"cli:agent:list","result":{"type":"agent_list","agents":[{"name":"trace-agent","agent":"pi","agent_status":"idle","pane_id":"w1:p2","tab_id":"w1:t2","workspace_id":"w1","cwd":"/tmp/.../checkout","state_change_seq":1,"focused":false,"foreground_cwd":...,"interactive_ready":true,"revision":1,"terminal_id":"term_...","terminal_title":"π - checkout",...}]}}`, and `{"agents":[]}` when no Agent stands. 0.8.2 stood no `agent_session`, no `session_id`, and no `checkout_path` in the recorded run: the working directory stands under `cwd`, and no Agent integration was installed in the isolated run | code 0: `{"result":{"agents":[{"pane_id","tab_id","workspace_id","agent","agent_status","name","checkout_path"(when the workspace names a checkout),"agent_session"(when the test names a session)}` | Matched on the fields the plane reads: `pane_id`, `agent`, `tab_id`, `workspace_id`, `agent_status`, and `name` stand in both, and the plane's reader takes the working directory from `checkout_path` or `cwd`. **Drift**: the world stands no `state_change_seq` (nor `sequence` or `state_change_sequence`), while 0.8.2 stands it and the plane's reader takes it. The world's `agent_session` shape is unverified: 0.8.2 stood none in the recorded run. See the drift table and the unverified list |
| `agent read <pane> --lines <n> --source recent-unwrapped --format text` | code 0, stdout is the raw pane text, unwrapped and capped, with no JSON envelope | code 0, stdout is the pane's recorded content | Matched: the plane's reader takes the raw stdout when it is not a JSON envelope, and the record is not one |
| `agent read <pane> --lines <n> --source visible --format ansi` | code 0, stdout is the raw ANSI grid of the pane's visible screen | code 0, stdout is the pane's recorded content | Matched on the shape: raw output on stdout. The world's content stands for the recorded grid |
| `agent wait <name> --until idle --until done --until blocked` for an Agent at a settle state | code 0: `{"id":"cli:agent:wait","result":{"agent":{...},"type":"agent_info"}}` | code 0, no stdout | Matched on the code, the one field the plane reads. Drift: the world omits the `agent_info` envelope |
| `agent focus <pane>` | code 0: `{"id":"cli:agent:focus","result":{"agent":{...},"type":"agent_info"}}` | code 0, no stdout | Matched on the code, the one field the plane reads. Drift: the world omits the envelope |
| `agent prompt <name> <text>` | code 0: `{"id":"cli:agent:prompt","result":{"agent":{...},"type":"agent_prompted"}}` | code 0, no stdout | Matched on the code, the one field the plane reads. Drift: the world omits the envelope |
| `worktree list --cwd <checkout>` | code 0: `{"id":"cli:worktree:list","result":{"source":{"repo_key":...,"repo_name":"checkout","source_checkout_path":...,"source_workspace_id":"w1"},"type":"worktree_list","worktrees":[{"branch":"main","is_linked_worktree":false,"path":"/tmp/.../checkout","open_workspace_id":"w1","label":"checkout","is_bare":false,"is_detached":false,"is_prunable":false},{"branch":"feature/opened","is_linked_worktree":true,"path":"~/.herdr/worktrees/checkout/feature-opened","open_workspace_id":"w2",...}]}}`. The list holds the source checkout itself as a worktree entry, beside the linked worktrees herdr made | code 0: `{"id":"cli:worktree:list","result":{"type":"worktree_list","worktrees":[{"branch","is_linked_worktree","is_prunable","path","open_workspace_id"}]}}` | Matched on the fields the plane reads (`path`, `is_linked_worktree`, `is_prunable`): the plane's reader finds the linked entries for its candidate-path rule, and the recorded list's linked entries stand the way the world's do. The recorded worktrees stand under `~/.herdr/worktrees/<repo>/<branch with slashes replaced>`, the layout the plane's candidate rule names. Drift: the world lists no source-checkout entry, and it omits the `source` section |
| `worktree create --cwd <checkout> --branch <branch> --base <ref> --no-focus` | code 0: `{"id":"cli:worktree:create","result":{"type":"worktree_created","workspace":{"workspace_id":"w2","worktree":{"checkout_path":"~/.herdr/worktrees/checkout/feature-opened",...}},"tab":{"tab_id":"w2:t1"},"root_pane":{"pane_id":"w2:p1","cwd":...},"worktree":{"branch":"feature/opened","path":...,"is_linked_worktree":true,...}}}` | code 0: `{"result":{"workspace":{"workspace_id"},"tab":{"tab_id"},"root_pane":{"pane_id"}}}` | Matched on the fields the plane reads. The world stands the created worktree under the described root, the way 0.8.2 stands it under `~/.herdr/worktrees` |
| `worktree open --cwd <checkout> --branch <branch> --no-focus` for a worktree herdr holds | code 0: `{"id":"cli:worktree:open","result":{"already_open":true,"workspace":{"workspace_id":"w2",...},"tab":{...},"root_pane":{...},"worktree":{"path":"~/.herdr/worktrees/checkout/feature-opened",...}}}` | code 0: the same fields, including `already_open` and `worktree.path` | Matched on the fields the plane reads, including the `already_open` fact and the `worktree.path` the plane opens a fresh tab in |
| `worktree open --cwd <checkout> --path <path> --no-focus` | code 0: the `already_open` envelope, for a path herdr holds. The recorded run also named the source checkout's own path, and 0.8.2 answered it with the `already_open` envelope on the `main` entry: to 0.8.2 the source checkout is an openable worktree | code 0: the `already_open` envelope for a path the world's checkouts hold as a linked worktree | Matched on the held-path shape. **Drift**: the world refuses the source checkout's own path with `worktree_not_found`, where 0.8.2 opens it. See the drift table |

### The herdr refusal envelope and its codes

Every recorded refusal came back on stderr as one line of JSON, with the
exit code 1: `{"error":{"code":"<code>","message":"<message>"},"id":"cli:<command>"}`.
The world's refusals stand the same line on stderr with the same code, and
the plane's `herdrErrorCode` reader takes the code out of it unchanged.

| The refusal the plane reads | The recorded herdr 0.8.2 answer | The world's answer | Verdict |
| --- | --- | --- | --- |
| A `workspace get`, `workspace close`, `tab list`, `pane list`, or `worktree remove` for a workspace herdr does not hold | `{"error":{"code":"workspace_not_found","message":"workspace ws-missing not found"},"id":"cli:..."}` | the same code, the same message | Matched |
| A `tab close` for a tab herdr does not hold | `{"error":{"code":"tab_not_found","message":"tab tab-missing not found"},"id":"cli:tab:close"}` | the same code, the same message | Matched |
| A `pane close`, `pane send-text`, or `pane send-keys` for a pane herdr does not hold | `{"error":{"code":"pane_not_found","message":"pane pane-missing not found"},"id":"cli:..."}` | the same code, the same message | Matched |
| An `agent start` under a name one of herdr's Agents holds | `{"error":{"code":"agent_name_taken","message":"agent name trace-agent is already used; candidates: terminal_id=term_65dccd6b822cc2 pane_id=w1:p2 workspace_id=w1 tab_id=w1:t2 cwd=/tmp/.../checkout status=Idle"},"id":"cli:agent:start"}` | the same code, its own message in the same `key=value` order | Matched on the code, and on the message the plane parses: the plane's holder reader takes `terminal_id= pane_id= workspace_id= tab_id=` out of the recorded message unchanged |
| An `agent start` in a pane that is not an available shell (an Agent stands in it) | `{"error":{"code":"agent_pane_busy","message":"agent target pane w1:p2 is not an available shell"},"id":"cli:agent:start"}` | the same code, the same message | Matched |
| An `agent start`, `agent wait`, `agent read`, `agent focus`, or `agent prompt` for a target herdr does not hold | `{"error":{"code":"agent_not_found","message":"agent target <target> not found"},"id":"cli:agent:<command>"}` - 0.8.2 answers `agent_not_found` for a missing pane on `agent read` and `agent focus` too, and for a missing pane on `agent start` it answers `agent_pane_not_found`, "agent target pane pane-missing not found" | `agent_not_found` for `wait`, `focus`, and `prompt`; **`pane_not_found`** for `read` and `focus`; **`agent_start_failed`** for `start` | **Drift** on the three codes the world stands. The plane reads no one of them: it takes the code only for `agent_name_taken` (the name search) and `agent_pane_busy` (the retry), and it treats every other refusal as a failed read or a failed start. See the drift table |
| A `worktree open` for a branch no worktree stands on | `{"error":{"code":"worktree_not_found","message":"worktree branch not found"},"id":"cli:worktree:open"}` | the same code, the same message | Matched |
| A `worktree open` for a path herdr does not hold | `{"error":{"code":"worktree_not_found","message":"worktree path not found"},"id":"cli:worktree:open"}` | the same code, the branch message | Matched on the code. The message stands for the branch case, not the path case |
| A `worktree create` on a base that names no ref | `{"error":{"code":"worktree_create_failed","message":"fatal: invalid reference: origin/no-such-ref"},"id":"cli:worktree:create"}` | code 1, no envelope: the raw git line `fatal: invalid reference: <ref>` | **Drift**: 0.8.2 wraps the git failure in its own envelope with the code `worktree_create_failed`; the world stands the raw git line. The plane reads no code off this failure, so the drift has no plane impact |
| A `worktree create` whose branch name 0.8.2 would already hold | **Not refused**: 0.8.2 answered code 0 with the `worktree_created` envelope when the branch stood on the remote and not locally. It stood the local branch and the worktree, and the later `worktree list` held the branch under the worktree | code 1: the raw git line `fatal: a branch named '<branch>' already exists` | **Drift**: the world refuses where 0.8.2 created. In the plane's flow the create reaches this standing only for a branch the flow established stands nowhere, so the plane's own path does not meet the refusal; the recorded 0.8.2 behavior stands beside the world's anyway |
| A `worktree remove` of a worktree with modified or untracked files | `{"error":{"code":"dirty_worktree_requires_force","message":"fatal: '<path>' contains modified or untracked files, use --force to delete it"},"id":"cli:worktree:remove"}` | the same code, its own message without the path | Matched on the code, the one the plane reads; the message stands differently |
| A `worktree remove` whose checkout directory is gone from disk | **Not refused**: 0.8.2 answered code 0 with the `worktree_removed` envelope, and the workspace went away with the removal | code 1: `{"error":{"code":"worktree_remove_failed","message":"fatal: the path is not a working tree"},"id":"cli:worktree:remove"}` | **Drift**: the world refuses where 0.8.2 removed. The plane ends at the same fact either way: on code 0 it takes the environment as gone, and on `worktree_remove_failed` it falls back to closing the workspace, which is gone in the record too. The plane's fallback branch never ran against 0.8.2 in this tracing. See the unverified list |

### The git answers, traced to git 2.55.0

Herdr answers no git command: the plane's git side leaves the plane through
the command runner and reaches git itself. The git family is therefore
traced to recorded answers of the git the operator runs - git 2.55.0 on
Linux x64 - not to a herdr answer. The scratch world stood a bare origin and
a clone of it, a remote-only `feature/trace-shape` branch, and the
`origin/HEAD` symref at `origin/main`, and every git shape the plane builds
ran against it with the plane's exact argv.

| The shape the plane builds | The recorded git 2.55.0 answer | The world's answer | Verdict |
| --- | --- | --- | --- |
| `git -C <checkout> rev-parse --git-dir` | code 0: `.git` | code 0: `.git` | Matched |
| `git -C <checkout> remote get-url origin` | code 0: the remote's URL or path, one line | code 0: the described clone URL, one line | Matched |
| `git -C <path> rev-parse --git-dir` and `remote get-url origin` for a path that is not a repository | code 128, `fatal: not a git repository (or any parent up to mount point /)` and the filesystem-boundary line, for a directory that is not a repository; code 128, `fatal: cannot change to '<path>': No such file or directory`, for a path that does not exist | code 128, `fatal: not a git repository (working tree '<path>')`, for both | Matched on the code, the one the plane reads: the plane checks the path for existence first and takes any nonzero code as "not a checkout". The message text stands differently in each case. See the drift table |
| `git -C <checkout> symbolic-ref refs/remotes/origin/HEAD` when the symref stands | code 0: `refs/remotes/origin/main` | code 0: `refs/remotes/origin/<defaultBranch>` | Matched |
| the same when the symref does not stand | code 128: `fatal: ref refs/remotes/origin/HEAD is not a symbolic ref` | code 1: `fatal: ref HEAD is not a symbolic ref` | **Drift** on the exit code (128 against the world's 1) and the message. The plane checks `code === 0`, so it falls to the `origin/main` and `origin/master` candidates either way. See the drift table |
| `git -C <checkout> rev-parse --verify --quiet <ref>^{commit}` | code 0 and the sha when the ref stands; code 1 and no output when it does not | the same, in both cases | Matched |
| `git -C <checkout> rev-parse <branch> <branch>^{tree}` | code 0: the branch's sha and its tree sha, one per line | the same | Matched |
| the same for a branch that does not stand | code 128: `fatal: ambiguous argument '<branch>': unknown revision or path not in the working tree.` with the hint lines, and the branch's name on stdout | code 128: `fatal: ambiguous argument '<branch>'` | Matched on the code and the failure fact. The record's stderr stands longer than the world's, and git stands the name on stdout; the plane checks the code and the line count of its stdout, and the record's extra stdout line fails the plane's two-line read the world's failure does |
| `git -C <checkout> fetch origin <branch>` and `fetch origin <branch>:refs/heads/<branch>` | code 0, the progress lines on stderr, no stdout | code 0, no output | Matched on the code. The record stands progress on stderr, the world none |
| `git -C <checkout> branch --list <branch>` | code 0: `  <branch>` (two leading spaces) when the branch stands locally, no output when it does not | the same, in both cases | Matched |
| `git -C <checkout> branch -D <branch>` | code 0: `Deleted branch <branch> (was <sha>).` | the same | Matched |
| the same for a branch that does not stand | code 1: `error: branch '<branch>' not found` | code 128: `fatal: branch '<branch>' not found` | **Drift** on the exit code (1 against 128) and the prefix (`error:` against `fatal:`). The plane takes any nonzero code as "the delete did not run" and moves on; the drift has no plane impact. See the drift table |
| `git -C <checkout> rev-parse HEAD` | code 0: the checkout's HEAD sha, one line | code 0: the described HEAD sha, one line | Matched |
| `git -C <checkout> status --porcelain --untracked-files=all` | code 0: no output on a clean tree, one porcelain line per change (the record stood `?? <file>` for the untracked file it added) | code 0: no output when the described tree is clean, `M  .factory-init` when it is not | Matched on the shape the plane reads: the empty check on the trimmed stdout. The record's line names the file it dirtied, the world's a fixed fixture line |
| `git -C <checkout> show origin/<branch>:<path>` | code 0: the file's content at the ref | code 0: the content the description holds for the path | Matched |
| the same for a path the ref does not hold | code 128: `fatal: path '<path>' does not exist in '<ref>'` | the same | Matched |
| the same for a ref that does not stand | code 128: `fatal: invalid object name '<ref>'.` | code 128: `fatal: unknown revision '<ref>'` | Matched on the code, the one the plane reads. The message stands differently. See the drift table |
| `git -C <checkout> commit-tree <tree> -p <parent> -m <message>` | code 0: the new commit's sha, one line (the record ran it with the author and committer identities the plane's runner stands) | code 0: a minted sha, one line | Matched on the shape |
| `git -C <checkout> update-ref refs/heads/<branch> <sha>` | code 0, no output | code 0, no output | Matched |
| `git -C <checkout> diff --quiet origin/<base> origin/<head>` | code 0 when the two remote trees stand alike, code 1 when they stand apart | the same, in both cases | Matched |
| `git -C <checkout> push --no-verify origin <branch>` | code 0: the `To <remote>` line and the ref line on stderr, no stdout | code 0: `To <cloneUrl>` on stdout | **Drift** on the channel: git 2.55.0 stands the `To` line on stderr, the world on stdout. The plane checks the code only. See the drift table |
| `git -C <worktree> push origin HEAD:<branch>` | code 0: the `To <remote>` line and the ref line on stderr (the record ran it with the remote branch standing, the standing under which git resolves the short destination) | code 0: `To <cloneUrl>` on stdout | The same channel drift |
| `git -C <checkout> ls-remote --heads origin <branch>` | code 0: `<sha>\trefs/heads/<branch>` when the remote stands the branch, no output when it does not | the same, in both cases | Matched |
| `git -C <checkout> worktree add --detach <path> origin/<branch>` | code 0: `Preparing worktree (detached HEAD <sha>)` on stderr and `HEAD is now at <sha> <subject>` on stdout | code 0, no output | Matched on the code, the one the plane reads. The record stands the preparation lines, the world none. See the drift table |
| `git -C <checkout> worktree remove --force <path>` | code 0, no output | code 0, no output | Matched |
| the same for a path that is no worktree | code 128: `fatal: '<path>' is not a working tree` | the same | Matched |
| `git clone <url> <path>` | code 0: `Cloning into '<path>'...` and `done.` on stderr | code 0, no output | Matched on the code. The record stands the clone lines, the world none |
| `git -C <worktree> add -A`, `status --porcelain`, `commit -m <message>`, `rev-parse HEAD` | code 0 in the record: no status output on the clean tree, `?? <file>` after the write, `A  <file>` after the add, `[detached HEAD <sha7>] <message>` with the diffstat lines on the commit, and the new HEAD sha | the same shapes, the world's commit line standing alone without the diffstat | Matched on the codes and the porcelain shapes. The world's commit line stands shorter than the record's. See the drift table |
| `git -C <worktree> commit -m <message>` on a clean worktree | code 1: `not currently on any branch.` and `nothing to commit, working tree clean` | code 1: `nothing to commit, working tree clean` | Matched on the code and the failure line. The record's detached tree stands one extra line |

### The drifts the tracing recorded

Each drift below stands between a world answer and its recorded answer, with
the impact on the plane as the tracing measured it. A drift with no plane
impact is a shape the plane does not read: it is recorded, and it stands
open for the world's next pass.

| # | The shape | 0.8.2 / git 2.55.0 answers | The world answers | Impact on the plane |
| --- | --- | --- | --- | --- |
| 1 | `pane send-keys` with `home`, `end`, `pageup`, or `pagedown` | code 1: `invalid_key`, "unsupported key <key>" | code 0, no output | **Measured, operator-visible**: the plane's semantic key set holds the four keys, so an operator who presses one in Agent interaction mode sees "Agent interaction failed" on the Message line against 0.8.2, and the key never reaches the pane. The world hides the refusal, so a suite standing on the world cannot see it. The key stands dropped, not translated |
| 2 | `pane send-keys` with a tmux-style key such as `C-m` | code 1: `invalid_key` | code 0, no output | None measured: the plane sends only its semantic set, and every member of it but the four above was accepted by the record |
| 3 | `agent start` in a pane herdr does not hold | code 1: `agent_pane_not_found` | code 1: `agent_start_failed` | None: the plane reads no code off the start beyond `agent_name_taken` and `agent_pane_busy`. The world's code stands for a standing 0.8.2 never stood in the record |
| 4 | `agent read` for a pane herdr does not hold, or a pane with no Agent | code 1: `agent_not_found`, in both cases | code 1: `pane_not_found` for a missing pane; the pane's content for a pane that holds no Agent | None measured: the plane reads only panes its own Agents stand in, and it takes any nonzero code as "the pane cannot be read" |
| 5 | `agent focus` for a pane herdr does not hold | code 1: `agent_not_found` | code 1: `pane_not_found` | None: the plane checks the code and shows the failure text either way |
| 6 | The `state_change_seq` of an `agent list` item | 0.8.2 stands it, and the plane's reader takes it out under that name | the world stands no sequence field on any of its items | The plane's state-change wake over a world Agent never sees a sequence, so the suites that stand on the world exercise the wake with no `state_change_seq`. The reader's own handling of the field is pinned against the recorded name in the observation suite |
| 7 | The `agent_session` of an `agent list` item | 0.8.2 stood none in the recorded run: no Agent integration was installed in the isolated run, so the record stands no session fields and the plane's reader then takes an empty session id | the world stands an `agent_session` record when a test names a session id | Unverified for 0.8.2 with an integration installed: the recorded run stood none, so the world's `{"kind":"path","source":"herdr:stub","value":...}` shape stands against the plane's reader, not against a 0.8.2 answer |
| 8 | `agent start` and `agent focus` and `agent prompt` and `agent wait` answers | a JSON envelope: the `agent_info` or `agent_prompted` or `agent_started` result beside the `id` | no stdout, code 0 | None: the plane checks the code on all four and reads no field of the stdout. The world's `agent start` also names the state `status`, where 0.8.2 names it `agent_status` |
| 9 | The `id` and `type` of every herdr answer | 0.8.2 stands an `id` on every answer and a `type` on most results | the world stands neither (its `worktree list` stands the `id`) | None: the plane reads neither |
| 10 | The id naming of workspaces, tabs, and panes | `w1`, `w1:t1`, `w1:p1` | `ws-1`, `tab-1`, `pane-1` | None: the plane treats the ids as opaque strings, and the world's counter keeps a created id clear of a described one |
| 11 | `worktree create` when the branch stands on the remote and not locally | code 0: the `worktree_created` envelope; 0.8.2 stood the local branch and the worktree | code 1: `fatal: a branch named '<branch>' already exists` | None measured in the plane's flow: the start fetches a standing remote branch onto the reuse path before it asks herdr for a create, so the plane's create carries a branch that stands nowhere local or remote. The world's refusal stands beside the recorded creation, and the suites that stand the refusal do so on the world's own standing |
| 12 | `worktree create` on a base that names no ref | code 1: the herdr envelope, `worktree_create_failed`, around the git line | code 1: the raw git line, no envelope | None: the plane takes the failure as a failed create either way and reads no code off it |
| 13 | `worktree open --path` on the source checkout's own path | code 0: the `already_open` envelope on the `main` entry | code 1: `worktree_not_found` | None measured: the plane names only a ticket branch's candidate path, which stands under the worktrees root, never the source checkout's path |
| 14 | `worktree remove` when the checkout directory is gone from disk | code 0: the `worktree_removed` envelope; the workspace goes away with the removal | code 1: `worktree_remove_failed` | None: the plane ends at the same fact on both answers - code 0 takes the environment as gone, and `worktree_remove_failed` closes the workspace, which is gone in the record too. The plane's fallback branch did not run against 0.8.2 in the tracing |
| 15 | `worktree list` entries | the list holds the source checkout itself, beside the linked worktrees, with a `source` section on the result | the world lists its linked worktrees only, with no `source` section | None: the plane's reader finds its candidate only among the linked entries, and the extra entry stands beside its read |
| 16 | The `workspace list` `worktree` section | 0.8.2 stands it once it has resolved the workspace's checkout: absent at once after a create, present in a later list | the world always stands it | None: the plane's reader takes `checkoutPath: null` when the section is absent, and a workspace the plane acts on has stood long enough to be resolved |
| 17 | The `git` answers for a path that is not a repository | code 128 with git's own discovery message, different for a missing path and for a non-repository directory | code 128: `fatal: not a git repository (working tree '<path>')` | None: the plane checks the path for existence first and takes any nonzero code as "not a checkout" |
| 18 | `symbolic-ref refs/remotes/origin/HEAD` when the symref does not stand | code 128: `fatal: ref refs/remotes/origin/HEAD is not a symbolic ref` | code 1: `fatal: ref HEAD is not a symbolic ref` | None: the plane checks `code === 0` and falls to the `origin/main` and `origin/master` candidates either way |
| 19 | `branch -D` of a branch that does not stand | code 1: `error: branch '<branch>' not found` | code 128: `fatal: branch '<branch>' not found` | None: the plane takes any nonzero code as "the delete did not run" on its cleanup path |
| 20 | `show` of a file at a ref that does not stand | code 128: `fatal: invalid object name '<ref>'.` | code 128: `fatal: unknown revision '<ref>'` | None: the plane checks the code |
| 21 | `push` output | git 2.55.0 stands the `To <remote>` line and the ref line on stderr | the world stands `To <cloneUrl>` on stdout | None: the plane checks the code and reads no push output |
| 22 | `worktree add --detach` output | git stands the `Preparing worktree` line on stderr and the `HEAD is now at` line on stdout | the world stands no output | None: the plane checks the code |
| 23 | The `rev-parse <branch> <branch>^{tree}` failure | code 128 with the long `ambiguous argument` message, and the branch's name on stdout | code 128 with the short `fatal: ambiguous argument '<branch>'` line | None: the plane checks the code and the two-line count of the stdout, and the record's extra stdout line fails that read the way the world's failure does |
| 24 | The `commit` line of a worktree commit | `[detached HEAD <sha7>] <message>` with the diffstat lines after it | the world stands the single line | None: the plane checks the code and reads the new HEAD from `rev-parse`, not from the commit's output |
| 25 | `clone` output | git stands `Cloning into...` and `done.` on stderr | the world stands no output | None: the plane checks the code |

### The shapes that could not be traced

The shapes below stood in the world before the tracing, and the tracing could
not measure them against a recorded 0.8.2 answer. They stand recorded as
unverified, and the claim stops at them.

| Shape | Why the tracing could not measure it |
| --- | --- |
| The held `agent wait` on an Agent that is not at a settle state: the block that runs until the Agent's state moves to `idle`, `done`, or `blocked` | the isolated run's Agent never left `idle`: the pane's pi held no model ("No models available"), so no Agent in the run ever stood `working` for a wait to hold on. The settle-state answer and the missing-target refusal were measured; the block was not |
| The emission of `worktree_remove_failed` by herdr 0.8.2 | the tracing measured 0.8.2's answers for the clean remove, the dirty remove, and the gone-checkout remove, and 0.8.2 refused none of the three with that code. The plane's fallback branch that reads the code therefore did not run against 0.8.2, and the standing that makes 0.8.2 emit the code was not found in the tracing |
| The `agent_session` and `session_id` fields of an `agent list` item with an Agent integration installed | no integration was installed in the isolated run, so 0.8.2 stood no session fields in the record. The world's session shape stands against the plane's reader, not against a 0.8.2 answer (drift 7) |
| The `agent start` answer with arguments after `--` | the run measured the start without arguments, the shape the plane's start takes when the agent's setting names no extra argument. The answer shape does not ride on the arguments, and a start with an argument the pane's pi would reject would have measured a startup failure, not the acceptance shape |
| The `agent start` refusal for a fresh pane that stays not-an-available-shell past herdr's own readiness wait | the measured fresh-pane start answered code 0 after herdr waited for the pane's shell (4 seconds in the record). 0.8.2's own wait makes the refusal a timeout past the wait window, and the tracing did not stand a pane that stays unreadable for the whole window |

## The migration state

| Flow | Files moved | Local builders deleted | Status |
| --- | --- | --- | --- |
| The checkout verification | the Consultation operations | its local `stubCheckout` copy | Moved |
| The checkout verification | the Action bar, the Consultation frame, the Handoff frame, the Key guide, the Live view, the Message line, the Starting face | their seven local `stubCheckout` copies stood on the world, and the plane-boot migration re-landed them on the pin table | Re-landed on the pin table by #366: those seven suites boot from the Seeded plane's total record, and the checkout stands on the fake command runner's git pins again |
| The checkout verification | the auto-mode suite | its `stubCheckout` copy and its local launch builders | Moved: each test's standing builds the world from the ticket's shape, its environment, and the agents and pane contents the test names, and the egress answers herdr and git from the world; the GitHub side the world does not hold stays pinned on the suite's fallback runner (issue #375) |
| The live-worktree Handoff | the Starting face and the Handoff frame's live-worktree Handoff tests | their `stubLiveHandoff` builders stood on the world, and the plane-boot migration re-landed them on the pin table | Re-landed on the pin table by #366 |
| The live-worktree Handoff | the Handoff frame's worktree Handoff tests and its pin-table tests | - | Out of this flow: the worktree Handoff is the next flow, and the pin-table tests stay |
| The worktree Handoff and its Worktree base read | the Handoff frame's worktree Handoff tests | its `stubWorktreeHandoff` builder stood on the world, and the plane-boot migration re-landed it on the pin table | Re-landed on the pin table by #366 |
| The worktree Handoff and its Worktree base read | the suites whose standing builders also pin the base read (the checkout hold, the auto-handoff chain, the herdr view frame, the repository select panel) | - | Their builders stand a live-worktree environment plus the base read for their own subject (the hold, the chain, the view, the panel); they are not the worktree Handoff's builder, and they stay |
| The Consultation launch, worktree side | the Consultation operations' worktree-launch tests: the full launch, the Replacement, the in-progress opening, the re-run without an Agent handle, and the free-gate pickup and recovery | the `stubWorktreeLaunch` builder the remaining worktree tests still used, deleted with them | Moved: those six stand the world's own worktree launch and name the world's handles; the launch's standing is `worktreeLaunchStanding` (the checkout and its worktrees root, no workspace) |
| The Consultation launch, live side, first batch | the Consultation operations' clean live-launch tests: the free live checkout, and the live-worktree pickup and recovery that cross no gate | the `stubLiveLaunch` builder the conflict tests still used, deleted with them | Moved: those three stand the world's own live launch, which makes the Agent's tab and pane, so the Agent sits in the world's first pane; the launch's standing is `liveLaunchStanding` (the operator's workspace, no tab) |
| The Consultation launch, the frame side | the Consultation frame's worktree-launch tests and its live-launch tests (the launcher's recovery, Replacement, free-seat, pickup, and the full operator flow) | `stubWorktreeLaunch`, `stubLiveLaunchExisting`, `stubLiveLaunchNew`, and the post-launch standings stood on the world, and the plane-boot migration re-landed them on the pin table | Re-landed on the pin table by #366; the Consultation operations' launch flows (the rows above) stand on the world |
| The Agent interaction's text and key sends | the Agent input queue's send tests (the queue seam) | their hand-pinned `pane send-text` and `pane send-keys` chunks: no builder stood there, so nothing is deleted - the seam stands the world's own pane and reads the sends from its `sentTextFor` and `sentKeysFor` records | Moved: the queue's in-flight windows stand on the world's own hold and on the delay wrapper over the world, the way they stood on the pin table's delay. The Consultation frame's interaction test (the UI seam) was re-landed on the pin table by #366 |
| The Consultation launch, live conflict side and the remaining worktree tests | the Consultation operations' live-conflict tests and its worktree failure, leftover, serialize, and start-line tests | `stubLiveLaunch`, `stubWorktreeLaunch`, `stubOpening`, and the pre-seeded `worktreeLaunchWorld` and `liveLaunchWorld` standings | Moved: the conflict tests stand `liveConflictWorld` (the operator's workspace holds the checkout, and the operator's own Agent works in its pane), and the conflicts' identities come from the world's own `agent list`. The one pin each failure test keeps is the one herdr answer the world cannot give: a raw-SHA worktree base (the world checks a base against ref names), a create refusal the plane reads and acts on, or the Agent start failure whose cleanup the test measures. The serialize stands both sides on the world: the close's standing is the worktree workspace, its tab and pane, and its Agent. The start-line and the Work queue dispatch stand `worktreeLaunchStanding`, and the world's own launch builds each record's environment |
| The Plane action merge and the Repository init | none: the Plane action merge's command-sequence tests and the Repository init's git writes stay on the pin table | - | The command is the subject: the merge's `commit-tree`, `update-ref`, and `push` sequence, and the init's commit stream, are pinned in full, so the pin table is the right adapter and the world is not. The world's own git write side (the same shapes) stands and is tested in the world's suite, so the plane's git writes are answered there whenever a flow's subject is the behaviour, not the command |

The auto-mode suite moved onto the world as its own step (issue #375): the
per-test rework the hold named. Each test's standing now builds the world's
description from the ticket's shape, its environment, and the agents and pane
contents the test names, and the plane's herdr and git egress routes through
the world. The suite's `stubCheckout` copy and its local launch builders are
deleted, and a test that verifies a herdr refusal the world does not hold
stands it on the world's own `set` override. The GitHub side the world does
not hold stays pinned: the settled tickets' `gh` reads and writes, and the
desktop notifications, fall through to the suite's fallback runner beside
the world, the way the world leaves the GitHub side unmodelled.

## Not measured

| Check | Why it could not run | Recorded as |
| --- | --- | --- |
| The held `agent wait` block on a working Agent, and the emission of `worktree_remove_failed` by 0.8.2 | the tracing's Agent never left `idle`, and 0.8.2 refused none of the tracing's removes with that code: the two shapes stand measured on the world, not on the binary | Incomplete: the unverified list of the tracing section names both, and the world's modeling of them stands beside the record without the trace |
| The `agent_session` and `session_id` fields of a 0.8.2 `agent list` with an Agent integration installed | no integration was installed in the isolated run | Incomplete: the world's session shape is unverified against a 0.8.2 answer (drift 7) |
| The seven frame suites' move onto the world | the plane-boot migration (#366) re-landed them on the pin table; their herdr and git answers stand on the fake command runner's pins again, and their move onto the world needs a per-test rework of their standings, its own step | Incomplete, recorded in the migration table above |
| The screen-reader path of the surfaces the suites touch | not verified in this branch's scope | Incomplete |
| The machine state beside the full suite | the full `bun run test` runs on the merged tree as this branch's push gate, with the plane's own processes live | Pending this branch's gate run: the numbers land in the paragraph below the table when the run answers |

The full `bun run test` for this branch's push gate runs on the merged tree
when the branch pushes; its result stands beside this record when it lands.
