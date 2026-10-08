# Documentation site verification

Status: the site build passes, and the built output was re-verified locally
on 2026-10-02, after the usage-focused rewrite (issue #189): the home page
carries the pitch and the "What the plane solves" section, the operator
pages carry usage only, the contributor content (the Development pages and
the ADRs) is de-emphasized under the single Contributing entry, and the
first-launch page carries the from-source path. The GitHub Pages deploy has
run for the pre-rewrite site: it is live at
<https://seriousjul.github.io/my-little-software-factory/>, and the
pre-rewrite home page structure was checked on 2026-09-29. The deploy
re-runs on the merge to main; the served-home rows below stand for the
pre-rewrite home page. What has not been measured is the interactive
lightbox flow, for the reason the section below states.

This record states what was measured, on what, and what was not measured. A
check that could not run is recorded as incomplete. It is not a pass, and it
is not silently dropped.

See [ADR 0018](../adr/0018-the-documentation-site-builds-from-the-docs-folder-with-vitepress.md)
for the decision, [ADR 0081](../adr/0081-the-operator-pages-carry-usage-and-the-adrs-carry-the-mechanics.md)
for the usage-only operator-page rule this rewrite lands, and
[the content conventions](../agents/site-content.md) for how pages are
written.

## What was verified locally

Measured on Node 26.9.0 and VitePress 1.6.4, from a clean checkout of the
branch, on 2026-10-02.

| Requirement | How it was checked | Result |
| --- | --- | --- |
| The build publishes the published subset: the home page, the six guide subfolders (Getting Started, Operation, Work flow, Configuration, Contributing, Development), and the 83 ADRs plus the ADR index | `bun run docs:build`, then the file list of `docs/.vitepress/dist` | Passed |
| The excluded folders (agents, research, verification) are absent from the built site | The file list of `docs/.vitepress/dist` contains none of them | Passed |
| The sidebar groups the published pages in the order Getting Started, Operation, Work flow, Configuration, and the single Contributing entry; the Development and ADR folders publish but take no sidebar group of their own | The built HTML sidebar of a doc page, read in document order | Passed |
| The home page renders a text-only hero (name, the new hero line, the kept tagline, two actions), the full-width herdr screenshot below it, the "What the plane solves" section with exactly three points, and the five-card guide grid, in that order | The built home page HTML, landmarks read in document order | Passed |
| Every home page link resolves under the project base on the Pages site: the two hero actions and the five guide cards | The built home page HTML: the hero actions carry the project base and name published pages, the guide cards carry relative targets that exist in the build root, and the hero image exists in the build root | Passed |
| The first-launch page carries the from-source path: clone, `bun install`, `bun run start`, and the line that it reads the same config file as the binary | The built first-launch page HTML carries the section and the config-file line | Passed |
| The `start` script runs the plane's entry point under Bun with no watch mode and no config argument, and the entry's existing argument handling resolves the same default config path the prebuilt binary uses | `bun run start --version` answers `factory 0.1.0` through the entry, and the binary passes the same argument list to the same entry module (`bin/factory-bin.mjs` hands `process.argv.slice(2)` to the entry) | Passed |
| The operator pages carry no ADR references: Getting Started, Operation, Work flow, Configuration, the home page, and the Contributing landing page | `grep` for `ADR` over the published operator content, excluding the ADR folder itself and the repository-only folders: no hits | Passed |
| The complete config example and the key reference stay published on the Configuration page, with the config comments free of ADR numbers | The built Configuration page HTML carries the example and the key reference; `grep` for `ADR` over `docs/configuration/index.md`: no hits | Passed |
| The screenshots are the display-scale sizes: the six operation shots are 4860 by 2440 and the hero is 6912 by 3416, each its grid times the pinned 27 by 61 cell | The PNG header dimensions of the committed assets, of the built assets, and of the assets the preview server serves | Passed (measured 2026-10-08, the display-scale repaint of ADR 0123) |
| The operation screenshots and the hero paint the theme the operator's herdr stands on (one-dark): the stream carries the Theme's exact 24-bit hex, and a cell that names no background stands on the pinned terminal background | The capture scripts mark the world as a herdr pane (`HERDR_ENV`) and name `COLORTERM=truecolor` beside `TERM=xterm-256color`, the pair herdr gives every pane, so the plane writes the Theme's 24-bit colors, and the terminal background, foreground, and sixteen basic colors are the pinned block beside `HERDR_THEME_NAME` in `scripts/screenshot-fixture.ts`; the regenerated frames carry the one-dark hexes (`38;2;40;44;52`, `38;2;97;175;239`, `38;2;171;178;191`) and no `38;5;`, the corner of `main-view.png` reads `#1a1b26`, and the drift test re-rendered the committed images byte-identical, on 2026-10-08 | Passed (measured 2026-10-08, the display-scale repaint of ADR 0123) |
| The built site serves the new images unresampled: the home page and an operation page return 200 under the project base, and every served screenshot - the six operation shots through the built asset names, the hero through its site path - is byte-identical to the committed asset at the pinned dimensions | `bun run docs:build`, then `bun run docs:preview`; the served page HTML carries the image references, and the served bytes were compared to the committed files one for one | Passed (measured 2026-10-08, through the preview server on port 4173) |
| The pages inside a group show in explicit reading order; Getting Started is prerequisites, first launch, minimal config, with no landing row | The built HTML sidebar of a doc page, read in document order | Passed |
| The home page "Get started" action and the Getting started card link to the first step (prerequisites), not to a landing page | The built home page HTML | Passed |
| The image lightbox code and styles are bundled into the site build | The built theme chunk contains the lightbox bindings (the `.vp-doc img` selector, the Escape and close handling, the overlay) and the built CSS contains the overlay styles | Passed (measured 2026-09-15, unchanged: the rewrite touches no theme file) |
| A broken internal link fails the build with a readable error naming the page and the link, for a link in the same folder and for a link into a parent folder | A temporary guide page was built with each shape: `[x](./does-not-exist.md)` fails with `Found dead link ./does-not-exist in file temp-guide/intro.md`, and `[x](../does-not-exist.md)` fails with `Found dead link ./../does-not-exist in file temp-guide/intro.md`; both builds exit nonzero | Passed (measured 2026-09-15, unchanged: the dead-link wiring was not touched) |
| A newly written guide folder appears in the sidebar without a config edit | A temporary guide folder was built: its pages appeared as a new sidebar group, and the build needed no config change | Passed (measured 2026-09-15, unchanged: the generated-sidebar rule was kept) |
| Links from published pages into repository-only content keep working | The built HTML of the shared control standard points at the repository for the verification record, the research page, the glossary, the README, the contributor instructions, and the source folder | Passed (measured 2026-09-15, unchanged) |
| An absolute link into an excluded folder is rewritten to the repository, and an absolute link to a published page stays a site link | A temporary guide page linked `[x](/verification/shared-controls.md)` and `[y](/adr/0001-open-tui-typescript.md)`: the built HTML points the first at the repository file, and the second at the built page under the project base; the build passes | Passed (measured 2026-09-15, unchanged) |
| The dev server and the preview server serve the site under the project base | `bun run docs:dev` and `bun run docs:preview`; the home page and an ADR page returned HTTP 200 under `/my-little-software-factory/` | Passed (measured 2026-09-15, unchanged: the rewrite touches no server config) |

The dead-link check needs no exemptions: the repo-only-links markdown rule
rewrites every repository-only target to an external repository URL before
VitePress checks links, so only internal links are checked, and an internal
link that does not resolve to a built page fails the build in any relative or
absolute shape.

The from-source start path runs the existing plane entry point. Its
behavior - config resolution, the startup decisions, the first-run config
write - is covered by the startup-module tests in the repository test
suite; the new `start` script in the package manifest adds no module and no
behavior.

## What was verified on the pull request

- The CI `checks` and `site-build` jobs on the pull request head
  (`f572d45`): both passed (run 36992455764, 2026-10-02). The `site-build`
  job runs the same `bun run docs:build` command as the local build above.
  The head also carries a merge of the branch with `main`, which had moved on
  after the branch was cut; the one file both sides touched, the completion
  page, keeps the usage rewrite, since the sentence `main` added there is the
  polling mechanic that ADR 0084 already carries.
- A load flake in `test/auto-mode.test.ts` (the auto decision
  model-resolution case) was found by CI and fixed on this branch. The test
  waited for the `auto-handed-off` frame and then read the `herdr agent
  start` command, but under the parallel CI load the frame can be captured
  before the runner records the start, so the command read `undefined` and
  the `toContain` assertion threw a type error. It failed twice in CI on this
  branch and passed in isolation and in the local full suite, the
  load-flake signature. The fix makes the `awaitFrame` predicate require the
  start command as well as the frame, the pattern the sibling route tests
  already use. The local full suite (2495 pass) and the CI `checks` job both
  pass after the fix.

## What was verified on the deployed site

Measured on 2026-09-29, by reading the HTML the live site serves, for the
pre-rewrite site. The deploy re-runs on the merge to main.

| Requirement | How it was checked | Result |
| --- | --- | --- |
| The deploy has run and the site is public | The repository's Pages state reports `built` on the latest `gh-pages` build (commit `8cf9a7f`, 2026-09-29), and the home page returns HTTP 200 at the project base | Passed |
| The pre-rewrite home page carried the herdr hero shot and the "Get started" action into the prerequisites step | The served home page HTML held the hero image reference and a link into the prerequisites page | Passed |
| The pre-rewrite sidebar listed the six published groups | The served home page HTML carried the Getting Started, Operation, Work flow, Configuration, Development, and ADR group names | Passed |

The full hand checklist for the deploy - the guide cards in order, one
Development page and one ADR page each rendered, the screenshots reading large
on a wide display, and the excluded folders absent - stays open until it is
checked by hand in a browser; the rows above cover what a read of the served
HTML can establish. Re-check it after the post-merge deploy, with the new
home page and the single Contributing entry.

## What has not been measured

- The interactive image lightbox flow. The lightbox code and CSS are in the
  build, but the click-to-open and the close paths (Escape, the backdrop, the
  close button) have not been exercised in a real browser, because the app is
  tested only at the unit layer and no desktop browser is driven in this
  environment. Record the result here when it has been checked by hand.
