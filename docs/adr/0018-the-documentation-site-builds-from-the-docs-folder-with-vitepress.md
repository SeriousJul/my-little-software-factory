# The documentation site builds from the docs folder with VitePress

Status: accepted.

The project publishes a documentation site on GitHub Pages for this
repository, and its content is written and maintained by agents. We decided the
site is built with VitePress directly from the existing `docs/` folder, so the
published site and the source documentation can never disagree. A published
subset is exposed (the ADRs, the standards, and guide subfolders), and the
internal folders stay in the repository but out of the build.

## Considered Options

- Docusaurus was liked for its flexibility, but its React and MDX toolchain is
  a larger failure surface for agent-authored content, and the features that
  justify it (versioned docs, i18n, custom components) are not needed.
- A separate site repository, or a dedicated site folder inside this
  repository, was rejected because it adds a copy or sync step that can drift
  from the documentation it is supposed to publish.

## Consequences

- The `docs/` folder is the site source root, and the site config and its
  build artifacts live inside it.
- ADRs, standards, and guides are public content. The agent instruction,
  verification, and research folders are repository content only.
- The sidebar is generated from the folder structure at build time. Adding a
  page is one action: write the file.
- New guide subfolders may be added by agents. New top-level sections are a
  maintainer decision.
- A CI job runs the site build, and a workflow deploys the build to the
  `gh-pages` branch on push to `main`.
