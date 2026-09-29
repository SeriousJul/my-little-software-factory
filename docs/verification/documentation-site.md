# Documentation site verification

Status: the site build passes, and the built output was verified locally on
2026-09-15, after the sidebar restructure (the Getting Started steps, the
explicit page order, the Development group, the compact ADR group, the larger
screenshots, the theme, and the image lightbox). The GitHub Pages deploy has
run: the site is live at
<https://seriousjul.github.io/my-little-software-factory/>, and the static
structure of the published home page was checked on 2026-09-29. The home
page's guide cards stood on absolute site paths that missed the project base
on the Pages site, and the links broke there; the cards now use relative
targets, and the built links were checked on 2026-09-29. What has not been
measured is the interactive lightbox flow, for the reason the section below
states.

This record states what was measured, on what, and what was not measured. A
check that could not run is recorded as incomplete. It is not a pass, and it
is not silently dropped.

See [ADR 0018](../adr/0018-the-documentation-site-builds-from-the-docs-folder-with-vitepress.md)
for the decision, and [the content conventions](../agents/site-content.md) for
how pages are written.

## What was verified locally

Measured on Node 26.8.1 and VitePress 1.6.4, from a clean checkout of the
branch, on 2026-09-15.

| Requirement | How it was checked | Result |
| --- | --- | --- |
| The build publishes the published subset: the home page, the five guide subfolders (Getting Started, Operation, Work flow, Configuration, Development), and the 63 ADRs plus the ADR index | `npm run docs:build`, then the file list of `docs/.vitepress/dist` | Passed |
| The excluded folders (agents, research, verification) are absent from the built site | The file list of `docs/.vitepress/dist` contains none of them | Passed |
| The sidebar groups the published pages in the order Getting Started, Operation, Work flow, Configuration, Development, ADR, and the ADR group lists the single index entry rather than one row per ADR | The built HTML sidebar of a doc page, read in document order | Passed |
| The home page renders a text-only hero (name, tagline, two actions), the full-width herdr screenshot below it, and the six-card guide grid, in that order | The built home page HTML, landmarks read in document order | Passed |
| The screenshots are the larger sizes: the six operation shots are 1620 by 800 and the hero is 2304 by 1120 | The PNG header dimensions of the built assets | Passed |
| The operation screenshots and the hero paint the theme the operator's herdr stands on (one-dark) | The capture scripts mark the world as a herdr pane (`HERDR_ENV`) and write a herdr config that names the theme the capture scripts pin, so the plane resolves it through the production theme path (ADR 0024); the regenerated frames carry the one-dark role colors, and the drift test re-rendered the committed images byte-identical, on 2026-09-29 | Passed |
| The pages inside a group show in explicit reading order; Getting Started is prerequisites, first launch, minimal config, with no landing row | The built HTML sidebar of a doc page, read in document order | Passed |
| The home page "Get started" action and the Getting started card link to the first step (prerequisites), not to a landing page | The built home page HTML | Passed |
| Every home page link resolves under the project base on the Pages site: the two hero actions and the six guide cards | The built home page HTML, read on 2026-09-29: the hero actions carry the project base, the guide cards carry relative targets, and each target names a page the build publishes | Passed |
| The image lightbox code and styles are bundled into the site build | The built theme chunk contains the lightbox bindings (the `.vp-doc img` selector, the Escape and close handling, the overlay) and the built CSS contains the overlay styles | Passed |
| A broken internal link fails the build with a readable error naming the page and the link, for a link in the same folder and for a link into a parent folder | A temporary guide page was built with each shape: `[x](./does-not-exist.md)` fails with `Found dead link ./does-not-exist in file temp-guide/intro.md`, and `[x](../does-not-exist.md)` fails with `Found dead link ./../does-not-exist in file temp-guide/intro.md`; both builds exit nonzero | Passed |
| A newly written guide folder appears in the sidebar without a config edit | A temporary guide folder was built: its pages appeared as a new sidebar group, and the build needed no config change | Passed |
| The sidebar groups every published page by folder, in the explicit `GROUP_ORDER` | The rendered sidebar of a built page shows the Getting Started, Operation, Work flow, Configuration, Development, and ADR groups, in that order | Passed |
| Links from published pages into repository-only content keep working | The built HTML of the shared control standard points at the repository for the verification record, the research page, the glossary, the README, the contributor instructions, and the source folder | Passed |
| An absolute link into an excluded folder is rewritten to the repository, and an absolute link to a published page stays a site link | A temporary guide page linked `[x](/verification/shared-controls.md)` and `[y](/adr/0001-open-tui-typescript.md)`: the built HTML points the first at the repository file, and the second at the built page under the project base; the build passes | Passed |
| The dev server and the preview server serve the site under the project base | `npm run docs:dev` and `npm run docs:preview`; the home page and an ADR page returned HTTP 200 under `/my-little-software-factory/` | Passed |

The dead-link check needs no exemptions: the repo-only-links markdown rule
rewrites every repository-only target to an external repository URL before
VitePress checks links, so only internal links are checked, and an internal
link that does not resolve to a built page fails the build in any relative or
absolute shape. Before this fix, the cross-folder shape above passed the
build; the fix removed the `ignoreDeadLinks` exemption that exempted every raw
link starting with `..` without resolving it against the page.

The temporary guide pages used for the dead-link and rewrite rows were removed
after the checks, and the final build was rerun clean.

## What was verified on the pull request

- The CI site build job on pull requests. Run 34790093877 ran the same
  `npm run docs:build` command on the pull request head (`2de11ac`) and
  passed, alongside the lint, typecheck, and test jobs.

## What was verified on the deployed site

Measured on 2026-09-29, by reading the HTML the live site serves.

| Requirement | How it was checked | Result |
| --- | --- | --- |
| The deploy has run and the site is public | The repository's Pages state reports `built` on the latest `gh-pages` build (commit `8cf9a7f`, 2026-09-29), and the home page returns HTTP 200 at the project base | Passed |
| The home page carries the herdr hero shot and the "Get started" action into the prerequisites step | The served home page HTML holds the hero image reference and a link into the prerequisites page | Passed |
| The sidebar lists the six published groups | The served home page HTML carries the Getting Started, Operation, Work flow, Configuration, Development, and ADR group names | Passed |

The full hand checklist for the deploy - the guide cards in order, one
Development page and one ADR page each rendered, the screenshots reading large
on a wide display, and the excluded folders absent - stays open until it is
checked by hand in a browser; the rows above cover what a read of the served
HTML can establish.

## What has not been measured

- The interactive image lightbox flow. The lightbox code and CSS are in the
  build, but the click-to-open and the close paths (Escape, the backdrop, the
  close button) have not been exercised in a real browser, because the app is
  tested only at the unit layer and no desktop browser is driven in this
  environment. Record the result here when it has been checked by hand.


