/**
 * The ambient declarations the TypeScript surface does not carry on its own.
 *
 * - A `*.toml` module is a file import (`with { type: "file" }`): its default
 *   export is a path to the file. In a source run the path is the plain
 *   repository path; in a compiled binary it is the path of the copy the
 *   build embedded in the binary.
 * - `FACTORY_BUILD_VERSION` is the version the release build stamps into a
 *   compiled binary through `bun build --define`. In a source run the
 *   identifier is undefined, and `src/version.ts` reads the repository's
 *   package.json instead.
 */
declare module "*.toml" {
	const file: string;
	export default file;
}

/**
 * A `*.md` module imported with `{ type: "text" }`: its default export is the
 * file's text, the byte content the deterministic generator writes into a
 * repository (ADR 0075). The content is resolved in a source run and embedded
 * in a compiled build, so the generator owns its templates as code, not as a
 * disk read.
 */
declare module "*.md" {
	const text: string;
	export default text;
}

declare const FACTORY_BUILD_VERSION: string | undefined;
