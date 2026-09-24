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

declare const FACTORY_BUILD_VERSION: string | undefined;
