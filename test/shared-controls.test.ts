/** Shared fields expose one editing baseline to every control-plane caller. */
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	DraftField,
	type FieldFacts,
	type FieldHandle,
	TextField,
} from "../src/components/shared/fields.ts";
import { awaitFrame, frameText } from "./app-harness.ts";

let renderer: { destroy: () => void | Promise<void> } | null = null;
afterEach(async () => {
	await renderer?.destroy();
	renderer = null;
});

/**
 * Render one field at a fixed size, and hand the test the frame setup.
 *
 * `enhancedKeys` turns on the Kitty keyboard protocol, so the same editing
 * contract is driven by the sequences an enhanced terminal sends as well as by
 * the ordinary ones: a terminal's capability must not change what a key means.
 */
async function withField(
	element: Parameters<typeof testRender>[0],
	width: number,
	height: number,
	body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
	enhancedKeys = false,
): Promise<void> {
	const setup = await testRender(element, { width, height, kittyKeyboard: enhancedKeys });
	await setup.flush();
	renderer = setup.renderer;
	await body(setup);
}

describe("the shared Draft field", () => {
	test("paints its visible label and keeps Enter as a newline", async () => {
		const onValueChange = vi.fn();
		await withField(
			createElement(DraftField, {
				label: "Initial input",
				value: "review design",
				focused: true,
				width: 32,
				height: 4,
				onValueChange,
			}),
			50,
			10,
			async (setup) => {
				expect(frameText(setup.captureCharFrame())).toContain("Initial input");
				setup.mockInput.pressArrow("left");
				setup.mockInput.pressEnter();
				await awaitFrame(
					setup,
					() =>
						onValueChange.mock.calls.some(
							([facts]) => (facts as FieldFacts).value === "review desig\nn",
						),
					"Enter to insert a newline at the caret",
				);
			},
		);
	});

	test("keeps the caret, the selection, and the undo history across a blur", async () => {
		const field = { current: null as FieldHandle | null };
		await withField(
			createElement(TextField, {
				label: "Model",
				value: "",
				focused: true,
				width: 24,
				fieldRef: field,
			}),
			40,
			6,
			async (setup) => {
				await setup.mockInput.typeText("anthropic/sonnet");
				setup.mockInput.pressKey("HOME");
				setup.mockInput.pressArrow("right", { shift: true });
				setup.mockInput.pressArrow("right", { shift: true });
				setup.mockInput.pressArrow("right", { shift: true });
				const frame = await awaitFrame(
					setup,
					() => field.current?.selection() === "ant",
					"a three-cell selection",
				);
				expect(field.current?.caret()).toBe(3);
				// A Key guide above the field takes the keys: the editing state the
				// operator left behind is still there when the field gets them back.
				field.current?.blur();
				setup.mockInput.typeText("x");
				await setup.flush();
				expect(field.current?.value()).toBe("anthropic/sonnet");
				field.current?.focus();
				expect(field.current?.selection()).toBe("ant");
				expect(field.current?.caret()).toBe(3);
				// Typing replaces the selected text, and undo gives it back.
				setup.mockInput.pressKey("q");
				await awaitFrame(
					setup,
					() => field.current?.value() === "qhropic/sonnet",
					"the typed character to replace the selection",
				);
				// Replacing a selection is two operations, so undo steps back
				// through them one at a time: the character the operator typed, then
				// the text that character replaced.
				setup.mockInput.pressKey("z", { ctrl: true });
				await awaitFrame(
					setup,
					() => field.current?.value() === "hropic/sonnet",
					"undo to take the typed character back out",
				);
				setup.mockInput.pressKey("z", { ctrl: true });
				await awaitFrame(
					setup,
					() => field.current?.value() === "anthropic/sonnet",
					"the second undo to give the replaced text back",
				);
				expect(frameText(frame)).toContain("Model");
			},
		);
	});

	test("Ctrl+A selects the whole text, the key the Key guide names for it", async () => {
		// The Draft field: the selection the key claims is a real one, because a
		// typed character replaces it.
		const draft = { current: null as FieldHandle | null };
		await withField(
			createElement(DraftField, {
				label: "Initial input",
				value: "copy this part",
				focused: true,
				width: 32,
				height: 3,
				fieldRef: draft,
			}),
			50,
			10,
			async (setup) => {
				setup.mockInput.pressKey("a", { ctrl: true });
				await awaitFrame(
					setup,
					() => draft.current?.selection() === "copy this part",
					"the whole draft selected",
				);
				setup.mockInput.pressKey("q");
				await awaitFrame(
					setup,
					() => draft.current?.value() === "q",
					"the typed character to replace the selection",
				);
			},
		);
		// The Text field, where Home still means line start and Ctrl+A means
		// select all: the two keys no longer fight over the same key.
		const text = { current: null as FieldHandle | null };
		await withField(
			createElement(TextField, {
				label: "Model",
				value: "openai/gpt-5.1",
				focused: true,
				width: 24,
				fieldRef: text,
			}),
			50,
			10,
			async (setup) => {
				setup.mockInput.pressKey("a", { ctrl: true });
				await awaitFrame(
					setup,
					() => text.current?.selection() === "openai/gpt-5.1",
					"the whole value selected",
				);
				setup.mockInput.pressKey("q");
				await awaitFrame(
					setup,
					() => text.current?.value() === "q",
					"the typed character to replace the selection",
				);
			},
		);
	});
});

describe("the shared Text field", () => {
	test("refuses a non-digit paste as one operation and states why", async () => {
		const onValueChange = vi.fn();
		const onRefuse = vi.fn();
		await withField(
			createElement(TextField, {
				label: "Context",
				value: "272000",
				focused: true,
				width: 16,
				digits: true,
				refusals: {
					character: "Context window accepts digits only",
					paste: "Context window accepts digits only: the pasted text was refused as a whole",
				},
				onValueChange,
				onRefuse,
			}),
			40,
			6,
			async (setup) => {
				await setup.mockInput.pasteBracketedText("1e3");
				const frame = await awaitFrame(
					setup,
					() => onRefuse.mock.calls.length > 0,
					"the paste refusal",
				);
				expect(onRefuse).toHaveBeenCalledWith(
					"Context window accepts digits only: the pasted text was refused as a whole",
				);
				// A refusal reports the field's state and never a new value: what the
				// caller holds is still the count the operator had typed.
				expect(onValueChange.mock.calls.map(([facts]) => facts.value)).toEqual([
					"272000",
					"272000",
				]);
				expect(frameText(frame)).toContain("Context 272000");
			},
		);
	});

	test("takes a paste of digits in full, in the same rule that refuses the rest", async () => {
		const onValueChange = vi.fn();
		await withField(
			createElement(TextField, {
				label: "Context",
				value: "12",
				focused: true,
				width: 16,
				digits: true,
				onValueChange,
			}),
			40,
			6,
			async (setup) => {
				await setup.mockInput.pasteBracketedText("3456");
				await awaitFrame(
					setup,
					() =>
						onValueChange.mock.calls.some(([facts]) => (facts as FieldFacts).value === "123456"),
					"the pasted digits to be taken",
				);
			},
		);
	});

	test("refuses one typed non-digit and keeps the value and the caret", async () => {
		const onRefuse = vi.fn();
		const field = { current: null as FieldHandle | null };
		await withField(
			createElement(TextField, {
				label: "Context",
				value: "1234",
				focused: true,
				width: 16,
				digits: true,
				fieldRef: field,
				refusals: { character: "digits only", paste: "digits only as a whole" },
				onRefuse,
			}),
			40,
			6,
			async (setup) => {
				setup.mockInput.pressKey("HOME");
				setup.mockInput.pressArrow("right");
				setup.mockInput.pressKey("x");
				await awaitFrame(setup, () => onRefuse.mock.calls.length > 0, "the typed refusal");
				expect(field.current?.value()).toBe("1234");
				expect(field.current?.caret()).toBe(1);
			},
		);
	});

	test("refuses non-ASCII printable characters in a digits field", async () => {
		const onRefuse = vi.fn();
		const field = { current: null as FieldHandle | null };
		await withField(
			createElement(TextField, {
				label: "Context",
				value: "12",
				focused: true,
				width: 16,
				digits: true,
				fieldRef: field,
				onRefuse,
			}),
			40,
			6,
			async (setup) => {
				await setup.mockInput.typeText("é١");
				await awaitFrame(
					setup,
					() => onRefuse.mock.calls.length === 2,
					"both non-ASCII typed refusals",
				);
				expect(onRefuse).toHaveBeenCalledTimes(2);
				expect(field.current?.value()).toBe("12");
			},
		);
	});

	test("refuses a non-digit paste while a selection is held, and keeps the value, the caret, and the selection", async () => {
		const onRefuse = vi.fn();
		const field = { current: null as FieldHandle | null };
		await withField(
			createElement(TextField, {
				label: "Context",
				value: "272000",
				focused: true,
				width: 16,
				digits: true,
				fieldRef: field,
				refusals: {
					character: "This field takes digits only",
					paste: "This field takes digits only: the pasted text was refused as a whole",
				},
				onRefuse,
			}),
			40,
			6,
			async (setup) => {
				// Hold a two-cell selection from the start of the value.
				setup.mockInput.pressKey("HOME");
				setup.mockInput.pressArrow("right", { shift: true });
				setup.mockInput.pressArrow("right", { shift: true });
				await awaitFrame(setup, () => field.current?.selection() === "27", "the held selection");
				await setup.mockInput.pasteBracketedText("1e3");
				await awaitFrame(setup, () => onRefuse.mock.calls.length > 0, "the paste refusal");
				expect(onRefuse).toHaveBeenCalledWith(
					"This field takes digits only: the pasted text was refused as a whole",
				);
				// The refusal was whole: the value, the caret, and the selection all stand.
				expect(field.current?.value()).toBe("272000");
				expect(field.current?.caret()).toBe(2);
				expect(field.current?.selection()).toBe("27");
			},
		);
	});

	test("enforces a stated character limit, and refuses the crossing edit as a whole", async () => {
		const onRefuse = vi.fn();
		const field = { current: null as FieldHandle | null };
		await withField(
			createElement(TextField, {
				label: "Model",
				value: "abc",
				focused: true,
				width: 88,
				maxLength: 5,
				fieldRef: field,
				onRefuse,
			}),
			100,
			6,
			async (setup) => {
				// A paste that would cross the limit is refused whole, and the row
				// states the limit in the field's own words.
				await setup.mockInput.pasteBracketedText("12345");
				await awaitFrame(
					setup,
					(f) => frameText(f).includes("the pasted text was refused as a whole"),
					"the limit refusal to be stated on the screen",
				);
				expect(onRefuse).toHaveBeenCalledWith(
					"This field holds at most 5 characters: the pasted text was refused as a whole",
				);
				expect(field.current?.value()).toBe("abc");
				// Edits that stay inside the limit are taken...
				setup.mockInput.pressKey("d");
				await awaitFrame(
					setup,
					() => field.current?.value() === "abcd",
					"the edit inside the limit",
				);
				setup.mockInput.pressKey("e");
				await awaitFrame(
					setup,
					() => field.current?.value() === "abcde",
					"the edit that fills the limit",
				);
				// ...and the one that crosses it is refused, with the limit stated.
				setup.mockInput.pressKey("f");
				await awaitFrame(setup, () => onRefuse.mock.calls.length === 2, "the second refusal");
				await awaitFrame(
					setup,
					(f) => frameText(f).includes("This field holds at most 5 characters"),
					"the second refusal to be stated on the screen",
				);
				expect(onRefuse).toHaveBeenLastCalledWith("This field holds at most 5 characters");
				expect(field.current?.value()).toBe("abcde");
			},
		);
	});

	test("folds a typed count to one spelling and keeps the caret with it", async () => {
		const field = { current: null as FieldHandle | null };
		await withField(
			createElement(TextField, {
				label: "Context",
				value: "",
				focused: true,
				width: 16,
				digits: true,
				fieldRef: field,
				normalize: (value: string) => (/^[0-9]+$/u.test(value) ? String(Number(value)) : value),
			}),
			40,
			6,
			async (setup) => {
				await setup.mockInput.typeText("007");
				const _folded = await awaitFrame(
					setup,
					(f) => frameText(f).includes("Context 7"),
					"the row to hold one spelling of the count",
				);
				expect(field.current?.value()).toBe("7");
				expect(field.current?.caret()).toBe(1);
			},
		);
	});
});

describe("both key protocols", () => {
	test("an enhanced terminal's sequences mean the same operations", async () => {
		const onValueChange = vi.fn();
		await withField(
			createElement(DraftField, {
				label: "Initial input",
				value: "",
				focused: true,
				width: 30,
				height: 3,
				onValueChange,
			}),
			46,
			8,
			async (setup) => {
				await setup.mockInput.typeText("alpha beta");
				const values = () => onValueChange.mock.calls.map(([facts]) => (facts as FieldFacts).value);
				// The caret moves one grapheme left, Enter draws a new line there,
				// and Ctrl+Z takes the new line back: an enhanced terminal changes
				// how a key is encoded, never what the key does.
				setup.mockInput.pressArrow("left");
				setup.mockInput.pressEnter();
				await awaitFrame(
					setup,
					() => values().includes("alpha bet\na"),
					"the enhanced Enter to add a line",
				);
				setup.mockInput.pressKey("z", { ctrl: true });
				await awaitFrame(setup, () => values().at(-1) === "alpha beta", "the enhanced undo");
			},
			true,
		);
	});

	test("an enhanced terminal keeps a digits field's refusal", async () => {
		const onRefuse = vi.fn();
		await withField(
			createElement(TextField, {
				label: "Context",
				value: "12",
				focused: true,
				width: 16,
				digits: true,
				onRefuse,
			}),
			40,
			6,
			async (setup) => {
				setup.mockInput.pressKey("e");
				await awaitFrame(setup, () => onRefuse.mock.calls.length > 0, "the enhanced refusal");
				expect(onRefuse).toHaveBeenCalledWith("This field takes digits only");
			},
			true,
		);
	});
});
