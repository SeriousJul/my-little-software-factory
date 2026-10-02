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
| The screenshots are the larger sizes: the six operation shots are 1620 by 800 and the hero is 2304 by 1120 | The PNG header dimensions of the built assets | Passed (measured 2026-09-29, unchanged: the rewrite touches no image) |
| The operation screenshots and the hero paint the theme the operator's herdr stands on (one-dark) | The capture scripts mark the world as a herdr pane (`HERDR_ENV`) and write a herdr config that names the theme the capture scripts pin, so the plane resolves it through the production theme path (ADR 0024); the regenerated frames carry the one-dark role colors, and the drift test re-rendered the committed images byte-identical, on 2026-09-29 | Passed (measured 2026-09-29, unchanged: the rewrite touches no image) |
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
  (`34bfa05`): both passed (run 36987582022, 2026-10-02). The `site-build`
  job runs the same `bun run docs:build` command as the local build above.
  The head is a merge of the branch with `main`, which had moved on after the
  branch was cut; the one file both sides touched, the completion page, keeps
  the usage rewrite, since the sentence `main` added there is the polling
  mechanic that ADR 0084 already carries.

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
