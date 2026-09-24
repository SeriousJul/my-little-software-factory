# Release verification

Status: the automated checks pass, including the installer and its shipped
bin entry, the release workflow's asset names, the build script, and the
shipped-default read of the prebuilt binary (ADR 0056). The
publish itself is not verified: the first release runs on the first `v*`
tag, after the one-time npm trusted publishing setup.

This record states what was measured, on what, and what was not measured. A
required check that could not run is recorded as incomplete. It is not a pass,
and it is not silently dropped.

See [ADR 0020](../adr/0020-the-control-plane-publishes-from-a-version-tag-with-a-short-alias-package.md)
for the release mechanism and the alias package.

## What is verified automatically

These checks run in `bun run test` and the docs build.

| Requirement | Checked by | Result |
| --- | --- | --- |
| A missing Config file is seeded at the path from the shipped Default configuration, verbatim, and the load reports that it seeded | `test/config.test.ts`, `test/startup.test.ts` | Passed |
| The embedded read of the shipped Default configuration returns the checked-in file's text verbatim in a source run, and the text validates, so a first run always seeds a usable config | `test/shipped-default.test.ts` | Passed |
| The checked-in Default configuration validates through the seam and carries the four workflow task types with their transitions, five states of the label machine, the `consult` Consultation type, zero ticket sources, and zero repository mappings | `test/config.test.ts` | Passed |
| The Default configuration keeps the development config minus the repository mappings, the ticket sources, the personal Consultation type, and the state file entry | diffed against `config/development.toml` by the author | Passed |
| The default Config path and the default state path live under the project name, and the state path honors the XDG state home | `test/config.test.ts` | Passed |
| The Bun version gate accepts versions at and above the floor, rejects versions below it, and the failure message names the required version, the actual one, and the reason | `test/runtime.test.ts` | Passed |
| A missing config starts the real executable through a pseudo-terminal with the seed note, and the control plane UI comes up on the seeded config | `test/executable.test.ts` | Passed |
| A `v*` tag runs lint, typecheck, the tests, and the docs build before any publish step, and a failed check stops the workflow | `.github/workflows/release.yml` structure, reviewed | Measured by inspection |
| The installer resolves every supported machine to a buildable target, and no machine resolves to a target the build does not publish | `test/installer.test.ts`, `test/build-binary.test.ts` | Passed |
| The producer and the consumer agree on the asset names, the checksums file name, and the download addresses | `test/installer.test.ts`, `test/build-binary.test.ts` (one `assetFileName` shared by both) | Passed |
| The release workflow's own asset names, its target list, its checksums file name, its smoke steps, and its upload list agree with `assetFileName` and `checksumFileName`, so no step names or sends a file the build never produces | `test/release-workflow.test.ts` (reads `.github/workflows/release.yml` as text; proved red when the Windows smoke named `factory-windows-x64.exe`, and red again when the upload line's `dist/factory-<version>-*` glob left the `.`-separated checksums file out of the release) | Passed |
| The release job checks the checksums file exists, names every asset it uploads, and verifies the bytes it names before it uploads | `test/release-workflow.test.ts` pins the checks in the job's own step text | Passed |
| The macOS smoke step makes its downloaded binary executable before it runs it, because `upload-artifact` stores no file modes | `test/release-workflow.test.ts` | Passed |
| Every step's `run` block keeps its text inside the block's own indentation, so a step's script cannot be cut short by a line that leaks to column zero | `test/release-workflow.test.ts` (reads all three workflow files line by line). Found on this pass by reading the release job back with a YAML parser: the `gh release create` step's multi-line `--notes` prose sat at column zero, which ended the `run: |` block, made GitHub's parser read the note as two top-level keys, and dropped the step's `gh release upload` line entirely. The text-only name checks could not see it, and the run went green | Passed |
| The musl smoke step installs the GNU C++ runtime the musl binary links, and answers `--version` in an alpine container | `test/release-workflow.test.ts` (the shape), and the author ran the step's own `docker run` line against the built `linux-x64-musl` binary (alpine 3.20, docker, 2026-09-24): without `libstdc++` the binary stops on `_ZSt15__once_callable` relocation errors, with it the run answers `factory 0.1.0` | Passed |
| The cache is keyed by target, so two machines of different architecture that share one home cannot read each other's note, and an empty or relative data home from the environment is ignored rather than resolved against the working directory | `test/installer.test.ts` | Passed |
| A cold `--version` is answered by the installer with the binary's own line, and asks the network for nothing; a cached `--version` still goes to the binary | `test/installer.test.ts` (the line is also pinned against the text `src/factory.ts` writes), and the packed bin through the npm shim answered `factory 0.1.0` with an empty data home in 0.2 s | Passed |
| The first run says it is downloading before it asks the network for anything, and a cached run says nothing | `test/installer.test.ts`, with the fetch and the writer faked; and the packed `./node_modules/.bin/factory` printed the note line before its incomplete-release line | Passed |
| The first run says it is downloading before it asks the network for the binary, and a cached run says nothing | `test/installer.test.ts`, with the fetch and the writer faked | Passed |
| The checksums file and the binary are bound by separate timeouts, and the binary's is raised by `MLSF_DOWNLOAD_TIMEOUT_MS` | `test/installer.test.ts` (both bounds, the readable line, and the override's parse) | Passed |
| The install note names the version, the target, and the binary's SHA-256; a cache that cannot account for itself (no note, another target's note, bytes written over, a note that does not parse) re-downloads instead of failing every later run | `test/installer.test.ts`, with the network faked | Passed |
| The install directory and its note are private to their owner, and every download carries a timeout so a stalled network ends the run with a line instead of hanging it | `test/installer.test.ts` | Passed |
| A Windows rename refused because the binary is running says to close the running control plane | `test/installer.test.ts` pins the line's decision (`renameFailureLine`); the raw `EBUSY` path itself is the operating system's, measured on the first Windows run | Passed (decision), Incomplete (the real busy rename) |
| The whole install-and-run (`runInstaller`) resolves the target, reuses or installs the cache, hands the arguments to the binary, and returns the line, the exit code, or the signal the entry then acts on | `test/installer.test.ts`, with the fetch and the child process faked | Passed |
| The published bin, started under Node through the symlink shape npm writes in `node_modules/.bin`, reaches the install step and runs the cached binary | `test/installer.test.ts` spawns `node` on the shipped `bin/factory-bin.mjs` twice: by its real path and through a shim, with a cache seeded so no request is made. It is red on the pre-fix entry guard (exit 0, no output) and green on the realpath'ed guard | Passed |
| A clean install of the packed tarball installs the installer and nothing else | The author ran `npm pack` and `npm install ./my-little-software-factory-0.1.0.tgz` in an empty project (npm, node 26, 2026-09-24): `added 1 package`, `node_modules` 36 kB, and `./node_modules/.bin/factory --version` reached the install step with its readable incomplete-release line | Passed |
| The checksums file is read before the asset, a mismatched or missing checksum installs nothing, and a verified asset lands at its cache path with its install note | `test/installer.test.ts`, with the network faked | Passed |
| The build command compiles the entry per target with the package's version stamped into the binary, and is the command the release leg runs | `test/build-binary.test.ts`, `test/release-workflow.test.ts` | Passed |
| The source run's `factory --version` reports the repository's package.json version | `test/version.test.ts` | Passed |
| A compiled `linux-x64` binary answers `factory --version` with the stamped version and seeds a missing config file from the embedded Default configuration, verbatim | The author compiled the binary and ran it on a pseudo-terminal (bun 1.4.2, linux-x64, 2026-09-24): `factory 0.1.0` with no state and no config on disk, then a `script`-owned pseudo-terminal run that wrote the seed note, left a byte-for-byte copy of `config/default.toml` (`cmp` clean), and drew the app's own words | Passed |
| Every one of the seven targets cross-compiles from one Linux host through the release leg's exact steps, and the output is the true executable of each target | The author ran `bun install --omit=optional` and `bun run build <target> --out dist` for all seven targets (bun 1.4.2, 2026-09-24); `file` reports ELF x64 and aarch64, the two musl targets with the musl interpreter, Mach-O x86_64 and arm64, and PE32+ | Passed |
| A built binary embeds the native core it runs, and the count and size are read off the artifact, not inferred from the leg | The author ran each leg's exact steps in a clean tree and counted the embedded cores with `strings` (bun 1.4.2, 2026-09-24). See the table below. The three non-Linux targets carry one core each; all four Linux targets carry both libc variants | Passed |
| Every release binary answers `--version` on its own operating system: `linux-x64` on its build runner, `linux-x64-musl` in an alpine container, `darwin-arm64` on macOS, `windows-x64` on Windows | The smoke jobs of `.github/workflows/release.yml`, run on every tag | Not measured until the first tag |

## The built artifact, read off the artifact

Each row is one leg of the release matrix, run in a clean tree: `bun install
--omit=optional` placed no platform core, `bun run build <target>` added its
own, and the compile embedded what the tree held. The core count is the number
of distinct `libopentui` (or `opentui.dll`) names inside the executable, read
with `strings`; the byte size is the file's own. Measured on bun 1.4.2, one
Linux x64 host, 2026-09-24, from version `0.1.0`.

| Target | Cores the leg installed | Embedded native libraries | Bytes |
| --- | --- | --- | --- |
| `linux-x64` | `core-linux-x64`, `core-linux-x64-musl` | 2 (`libopentui-063zwc4s.so`, `libopentui-6k25x2jj.so`) | 101,316,064 |
| `linux-x64-musl` | `core-linux-x64`, `core-linux-x64-musl` | 2 (the same two) | 95,286,832 |
| `linux-arm64` | `core-linux-arm64`, `core-linux-arm64-musl` | 2 (`libopentui-8gtkpksy.so`, `libopentui-fd1jyn2w.so`) | 100,452,648 |
| `linux-arm64-musl` | `core-linux-arm64`, `core-linux-arm64-musl` | 2 (the same two) | 93,588,688 |
| `darwin-x64` | `core-darwin-x64` | 1 (`libopentui-rvcrmxgs.dylib`) | 82,342,160 |
| `darwin-arm64` | `core-darwin-arm64` | 1 (`libopentui-raaacmes.dylib`) | 75,254,898 |
| `windows-x64` | `core-win32-x64` | 1 (`opentui-sdp148ma.dll`) | 99,871,232 |

So the release's claim is: a binary embeds the native library it runs, and a
Linux binary embeds its sibling too. `bun add --os=<os> --cpu=<cpu>` resolves
an operating-system and architecture pair, not a libc, and `@opentui/core`'s
asset loader names all six platform packages in literal dynamic imports, which
the bundler must resolve whatever `--target` it is given. The dead sibling is
about 6.3 MB per Linux artifact - `libopentui.so` is 6,312,560 bytes on the
glibc package and 6,292,208 on the musl one.

Two routes to drop it were measured on the `linux-x64` leg, and neither works
from this repository:

- `bun build --external:@opentui/core-linux-x64-musl` compiled, and the output
  was byte-for-byte the size of the plain build (101,316,064) with both
  `libopentui-*.so` names still inside. The flag does not take the asset out.
- Moving the sibling package out of `node_modules` and rebuilding failed
  before any output: `error: Could not resolve:
  "@opentui/core-linux-x64-musl"` at
  `node_modules/@opentui/core/chunk-bun-37s3zwb6.js:8130:30`. No
  `--allow-unresolved` form built either: the package's own pattern stops at
  the opaque `import(specifier)` two functions down
  (`chunk-bun-37s3zwb6.js:11909`, which tells you to pass an empty-string
  pattern), and the empty-string pattern - alone or beside the package's -
  leaves the literal import at `:8130` unresolved. A tree without the sibling
  has no route to an artifact.

The remaining route is upstream: OpenTUI's loader has to stop naming a variant
it is not running, or this release accepts the extra 6.3 MB on the four Linux
targets. This record states the second, per target, from the artifact.

## What is verified at the first publish

The release download, the real binary's exec, the workflow itself, the
trusted publishing grant, and the provenance attestations are the parts that
live outside this repository. Their decisions now have a unit seam
(`runInstaller`, `test/installer.test.ts`, `test/release-workflow.test.ts`),
and the entry was run under Node against a seeded cache; what stays here is
the network's own half and the real asset. They are verified on the first
`v*` tag, after the one-time npm trusted
publishing setup that grants publish permission for both package names to
this repository. Until that tag runs, every row below is incomplete.

| Requirement | How it is measured | Result |
| --- | --- | --- |
| `npx my-little-software-factory` installs the prebuilt binary from the release and starts the control plane on a machine with no repository checkout and no Bun | Run the command in a clean environment; record the start lines and the UI | Incomplete |
| `npx mlsf` starts the same app, through the alias launcher and the same installer | Run the command in a clean environment; record the start lines and the UI | Incomplete |
| `npm install -g my-little-software-factory` and the `factory` command it writes start the same app. The packed tarball install and the shim's run path were measured locally on 2026-09-24 against the release that does not exist yet, which is why the incomplete-release line is the recorded answer there | Run the install in a clean environment and start `factory`; record the download, the start lines, and the UI | Incomplete |
| The first start seeds the Config file at `~/.config/my-little-software-factory/config.toml` and the start lines carry the seed note | Inspect the file and the start lines after the first run. The seed itself is measured on the compiled binary above | Incomplete |
| A second start runs the cached binary without the network, and a new version downloads its own binary | Run the command twice; record that the second run makes no download and that a version bump re-downloads. Both decisions are pinned in `test/installer.test.ts` with the network faked | Incomplete |
| The release job creates the release once and a re-run completes it instead of failing on the name the create step took | The workflow runs on the tag; re-run the release job and record that it uploads | Incomplete |
| The published package carries provenance naming this repository and the release commit | `npm view` with the attestations for both package versions | Incomplete |
| A tag whose version does not match the manifests stops before any publish | The workflow's tag check step fails the run | Incomplete |

## Notes

- The download bounds are stall guards, not link promises, and the link this
  machine has is recorded so the size of the guard is visible: a 36,646,985-byte
  GitHub release asset fetched with `curl` on 2026-09-24 took 0.50 s
  (73.2 MB/s). At that rate the 101 MB `linux-x64` binary is about 1.4 s, and
  the 600 s bound on an asset is roughly 400 times what this machine needs. The
  checksums file keeps its own 30 s bound.
- The reuse check reads the cached binary's SHA-256 before every run. On
  the 96.6 MiB (101,316,064 byte) `linux-x64` binary of this pass that cost
  45 ms under Node 26, and the digest it takes matches `sha256sum` for the
  same file.
- The npm name `factory` is taken on the public registry. That is why the
  short access path is the separate `mlsf` alias.
- The `linux-arm64` and `darwin-x64` binaries are built by the release but
  take no runner smoke: no runner for them exists in the workflow. They are
  unverified on a machine until one runs them, and this record says so.
- The release binaries are not signed. macOS Gatekeeper and Windows
  SmartScreen show their first-run warning on a freshly downloaded binary
  until signing lands (ADR 0056); the SHA-256 verification is the check that
  stands in for the signature until then.
- The one-time trusted publishing setup is interactive on the npm account
  side and is guided by a wizard the maintainer runs before the first tag.
- The first release is `0.1.0`, the version the package already declares.
  Both manifests must match the tag; the workflow checks it.
- Every workflow pins the same Bun, `1.4.2`, the compiler this record's
  cross-compile and binary runs were measured on: the release ships from no
  compiler the gates did not run. `test/release-workflow.test.ts` fails if
  one pin drifts from the others.
- The rework run of this branch measured `bun run lint`, `bun run typecheck`,
  `bun run test` (2050 pass, 0 fail, 0 skipped, bun 1.4.2, node 26.9.0), and
  `bun run docs:build`, all green, on the tree rebased onto `main` at
  `58e062c`. No other `bun test` process was running on the machine when the
  gate ran; the check is recorded here rather than assumed. The suite's own
  pseudo-terminal and screenshot cases skip on a machine that cannot run
  them, so a run that reports skips is the machine, not the branch.
- The rebase itself is part of this record: `ADR 0055` (mutation testing,
  #157) landed after the last rebase and touched `package.json`, `bun.lock`,
  `docs/adr/index.md`, and `docs/development/commands.md`. The four conflicts
  are resolved to hold both intents: the app's runtime libraries stay in
  `devDependencies`, and Stryker's runner and core join them.
- Every claim this pass read off a built artifact is in the table above, and
  the two routes to shrink a Linux artifact are recorded with the command that
  failed and the error it gave, so the next reader does not re-try them.
- The Windows busy-rename line is the decision of one pure function; the
  operating system's `EBUSY` behind it was not produced on a Windows
  machine in this pass. It stays the row above rather than a claim here.
