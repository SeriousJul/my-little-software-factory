# Writing Documentation site content

The Documentation site builds from the `docs/` folder with VitePress, per
[ADR 0018](../adr/0018-the-documentation-site-builds-from-the-docs-folder-with-vitepress.md).
The published subset is the ADRs, the top-level standards pages, and every
guide subfolder. The `agents/`, `verification/`, and `research/` folders stay
in the repository and out of the build; the exclusion is declared once in the
site config.

Publishing a page is one action: write the file. The sidebar is generated from
the folder structure at build time, in name order, so no configuration edit is
ever needed for a new page.

## Conventions

- File names are kebab-case and end in `.md`: `my-new-guide.md`.
- Every page starts with a frontmatter block. `title` is required and
  `description` is optional:

  ```markdown
  ---
  title: My New Guide
  description: One sentence for the page list.
  ---
  ```

- A new guide goes in its own subfolder of the docs root, for example
  `docs/my-new-guide/`. The folder name is the sidebar group.
- A new top-level section (a new docs-root folder or a new top-level page) is
  a maintainer decision, not an agent one.
- Internal links use repository-relative paths, like
  [`[the standard](../shared-controls.md)`](../shared-controls.md). A link from
  a published page into repository-only content (an excluded folder, or a file
  outside `docs/`) is rewritten to the repository on the site, so it keeps
  working in both places.
- Do not write pages into `agents/`, `verification/`, or `research/` expecting
  them to appear on the site.

## Verify before pushing

Run these from the repository root:

| Command             | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run docs:dev`  | Starts the local dev server with live reload                    |
| `npm run docs:build`| Builds the site; a broken internal link fails the build with a readable error naming the page and the link |
| `npm run docs:preview` | Serves the built site locally before it is published        |

Run `npm run docs:build` before pushing. CI runs the same build on every pull
request, so a broken page blocks the merge, and a push to `main` deploys the
site to the project's GitHub Pages site.
