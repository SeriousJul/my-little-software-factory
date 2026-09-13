# Documentation site verification

Status: the site build passes, and the built output was verified locally on
2026-09-14. The GitHub Pages deploy has not run yet: it is triggered by the
push to `main` that merges the change, and the manual checks on the published
URL below are incomplete until it has.

This record states what was measured, on what, and what was not measured. A
check that could not run is recorded as incomplete. It is not a pass, and it
is not silently dropped.

See [ADR 0018](../adr/0018-the-documentation-site-builds-from-the-docs-folder-with-vitepress.md)
for the decision, and [the content conventions](../agents/site-content.md) for
how pages are written.

## What was verified locally

Measured on Node 26.8.1 and VitePress 1.6.4, from a clean checkout of the
branch, on 2026-09-14.

| Requirement | How it was checked | Result |
| --- | --- | --- |
| The build publishes the published subset: the home page, the 18 ADRs, and the two top-level standards pages | `npm run docs:build`, then the file list of `docs/.vitepress/dist` | Passed |
| The excluded folders (agents, research, verification) are absent from the built site | The file list of `docs/.vitepress/dist` contains none of them | Passed |
| A broken internal link fails the build with a readable error naming the page and the link | A temporary page with a dead link was built: `Found dead link ./does-not-exist in file sample-guide/intro.md`, build failed | Passed |
| A newly written guide folder appears in the sidebar without a config edit | A temporary guide folder was built: its pages appeared as a new sidebar group, and the build needed no config change | Passed |
| The sidebar groups every published page by folder, in name order | The rendered sidebar of a built page shows the Standards group and the ADR group, in name order | Passed |
| Links from published pages into repository-only content keep working | The built HTML of the shared control standard points at the repository for the verification record, the research page, the glossary, the README, the contributor instructions, and the source folder | Passed |
| The dev server and the preview server serve the site under the project base | `npm run docs:dev` and `npm run docs:preview`; the home page and an ADR page returned HTTP 200 under `/my-little-software-factory/` | Passed |

The temporary pages used for the last two rows were removed after the check,
and the final build was rerun clean.

## What has not been measured

- The GitHub Pages deploy. The site deploy workflow builds on push to `main`
  and publishes to the `gh-pages` branch. It has not run, because the change
  is not merged yet. After the merge, open
  <https://seriousjul.github.io/my-little-software-factory/> and check by hand:
  the home page names the sections and links into them, one ADR page and one
  standards page render, the sidebar lists the published pages grouped by
  folder, and the excluded folders are absent. Record the result in this
  section when it has run.
- The CI site build job on pull requests. It runs the same `npm run docs:build`
  command that passed locally, but the workflow itself has not completed a run
  on this change yet.
