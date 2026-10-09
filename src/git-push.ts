/**
 * The control plane's own push rule (ADR 0127).
 *
 * `scripts/git-hooks/pre-push` is the contributor gate of ADR 0105: it runs
 * `bun run lint` and `bun run typecheck`, and refuses a push whose branch is
 * behind its remote-tracking ref. It is active in any checkout that set
 * `core.hooksPath`, and that setting is common to every worktree of a
 * repository, so it also runs on a push the plane itself makes.
 *
 * That gate answers for a tree the plane never pushed. The plane's pushes
 * carry its own commits - the pull request hold commit of ADR 0076, and a
 * Repository init's first commit of ADR 0075 - and their checks belong to CI,
 * which runs the same three on what lands. Meanwhile the hook reads the
 * checkout it stands in: a shared checkout whose dependencies are not
 * installed, or a fresh worktree with no `node_modules`, fails `bun run lint`,
 * the push is refused, and the plane reports only git's last line. So every
 * push the plane builds spreads this constant into its argv.
 *
 * A contributor's push keeps the gate unchanged: the hook stays active, and
 * `AGENTS.md` still refuses `--no-verify` for the work a person pushes.
 */

/** The flag git documents for skipping the pre-push hook, and nothing else. */
export const BYPASS_CONTRIBUTOR_PUSH_HOOK: readonly string[] = ["--no-verify"];
