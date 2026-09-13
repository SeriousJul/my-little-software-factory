/**
 * The shared control library is required, not recommended.
 *
 * The standard says a new directory or a written rule alone would leave the
 * problem in place, so this check reads the source and refuses the two ways a
 * screen can opt out: its own field implementation, and a private key path that
 * edits text the shared field should have edited. A control plane where one
 * screen drifts back to a local editor is a control plane where the operator
 * learns the baseline twice.
 *
 * The rule is a declared dependency rule, and it is not a behavior test: what
 * the operator sees is checked by the flow tests that drive the real screens.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/** Every TypeScript source file under `src`, the library's own files aside. */
function sourceFiles(directory: string, keep: (file: string) => boolean = () => true): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sourceFiles(path, keep));
			continue;
		}
		if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
			const rel = relative(process.cwd(), path);
			if (keep(rel)) found.push(rel);
		}
	}
	return found;
}

/** The library's own directory: the only place a renderer field may live. */
const LIBRARY = "src/components/shared/";

const screens = sourceFiles("src", (file) => !file.startsWith(LIBRARY));
const library = sourceFiles("src", (file) => file.startsWith(LIBRARY));

describe("the shared control library is the only control implementation", () => {
	test("no screen builds a field out of a renderer primitive", () => {
		// `createElement("input")` and `createElement("textarea")` are the raw
		// OpenTUI fields. A screen that holds one owns its own caret, its own
		// paste rule, and its own undo history, which is exactly what the
		// standard forbids now that the library exists.
		const offenders: string[] = [];
		for (const file of screens) {
			const source = readFileSync(file, "utf8");
			if (/createElement\(\s*["'](input|textarea)["']\s*[,)]/u.test(source)) offenders.push(file);
			// JSX or a catalogue entry that names a renderer field is the same
			// bypass in another spelling.
			if (/<(input|textarea)\b/u.test(source)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	test("no screen keeps text in a variable it edits by hand", () => {
		// The reported failures all came from a screen that appended a key's name
		// to its own draft string: `draft += key.name`. Editing a field's text
		// outside a field cannot move a caret, keep a selection, or hold undo
		// history, so the pattern is the bypass this rule exists to catch.
		const offenders: string[] = [];
		for (const file of screens) {
			const source = readFileSync(file, "utf8");
			const manualEdits = [
				/\bdraft\w*\s*\+=\s*/u,
				/\binput\w*\s*=\s*[^;]*slice\([^)]*,-\s*1\s*\)/u,
				/\b\w*[Dd]raft\w*\.current\s*\+=/u,
			];
			if (manualEdits.some((pattern) => pattern.test(source))) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	test("only the library touches the renderer's field renderables", () => {
		// `InputRenderable` and `TextareaRenderable` are the primitives the
		// library wraps. A caller that names one is repairing a buffer or a caret
		// by hand, which the standard says the library must do instead.
		const offenders: string[] = [];
		for (const file of screens) {
			const source = readFileSync(file, "utf8");
			if (/\b(InputRenderable|TextareaRenderable|EditBufferRenderable)\b/u.test(source)) {
				offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no screen paints an action row outside the shared row", () => {
		// `actionRowSpans` is the raw paint of one action row: the marker, the
		// label column, and the detail, in the shared presentation. A screen
		// that reaches it paints its own action row, and a row painted outside
		// the shared ink cannot take the light or the no-color presentation.
		// The shared `ActionItem` is the one caller.
		const offenders: string[] = [];
		for (const file of screens) {
			const source = readFileSync(file, "utf8");
			if (/\bactionRowSpans\b/u.test(source)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	test("the library wraps its primitives in exactly one place", () => {
		// The rule is not only "outside the library, no fields" but "inside the
		// library, one field each": a second Text field inside the library would
		// be a second baseline with a shared folder name.
		const wrapped = library.filter((file) => {
			const source = readFileSync(file, "utf8");
			return /createElement\(\s*["'](input|textarea)["']\s*[,)]/u.test(source);
		});
		expect(wrapped).toEqual([`${LIBRARY}fields.ts`]);
	});

	test("every field a screen draws comes from the library", () => {
		// The three surfaces the standard names first must import the library, so
		// a migration cannot quietly leave one of them behind.
		const required = [
			"src/components/override-panel.ts",
			"src/components/consultation-launcher.ts",
			"src/components/response-editor.ts",
		];
		for (const file of required) {
			const source = readFileSync(file, "utf8");
			expect(source, `${file} must use the shared control library`).toMatch(
				/from "\.\/shared\/(fields|form|choices|type-ahead|presentation)\.ts"/u,
			);
		}
	});

	test("selector screens take their rows and cycling from the library", () => {
		// A selector row and its wrapped cycle are shared behavior: the index,
		// the wrap, and the empty-value rule live in one module, and a screen
		// that owns the cycle owns a second selector. The two surfaces that
		// offer a selector must take the row and the shared helper from the
		// choice module, so neither can drift back to a local row or wrap.
		const required = [
			"src/components/override-panel.ts",
			"src/components/consultation-launcher.ts",
		];
		for (const file of required) {
			const source = readFileSync(file, "utf8");
			expect(source, `${file} must take its selector row from the shared choice module`).toMatch(
				/from "\.\/shared\/(choices|type-ahead)\.ts"/u,
			);
			expect(
				source,
				`${file} must take its selector cycling from the shared choice module`,
			).toMatch(/\b(useChoice|cycleChoice)\b/u);
		}
	});

	test("every action surface takes its rows from the library", () => {
		// An action row is shared presentation: the marker, the label, the
		// refusal word, and the ink all come from one place. Each surface that
		// offers actions must draw them through the shared `ActionItem`, so a
		// row cannot paint itself in a palette the presentation does not own.
		const required = [
			"src/components/action-panel.ts",
			"src/components/decision-modal.ts",
			"src/components/missing-modal.ts",
			"src/components/response-editor.ts",
			"src/components/live-view.ts",
			"src/components/consultation-launcher.ts",
		];
		for (const file of required) {
			const source = readFileSync(file, "utf8");
			expect(source, `${file} must draw its action rows through the shared row`).toContain(
				"ActionItem",
			);
		}
	});
});
