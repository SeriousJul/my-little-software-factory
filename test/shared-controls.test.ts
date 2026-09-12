/** Shared fields expose one editing baseline to every control-plane caller. */
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { afterEach, describe, expect, test, vi } from "vitest";

import { ChoiceRow } from "../src/components/shared/choices.ts";
import {
	DraftField,
	type FieldFacts,
	type FieldHandle,
	TextField,
} from "../src/components/shared/fields.ts";
import { ownNoteCells } from "../src/components/shared/presentation.ts";
import { TypeAheadRow } from "../src/components/shared/type-ahead.ts";
import { COLORS } from "../src/components/theme.ts";
import { awaitFrame, frameText, rgb, rowsOf, spanColors } from "./app-harness.ts";

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

describe("the written reason a control states", () => {
	/** A reason longer than any value column, as the Setting fit module writes it. */
	const REASON =
		'agent type "pilot" defines no context window setting, so the count of 272000 tokens cannot reach it';
	/** The rendered row a control wrote its reason on. */
	function reasonRow(frame: string): string {
		const row = rowsOf(frame).find((candidate) => candidate.includes("Error:"));
		if (row === undefined) throw new Error("no rendered row states a reason");
		return row;
	}

	test("a Text field states a whole reason on the width its surface names", async () => {
		await withField(
			createElement(TextField, {
				label: "Context",
				value: "272000",
				focused: true,
				width: 16,
				labelWidth: 10,
				error: REASON,
				noteWidth: 116,
			}),
			120,
			6,
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(candidate) => candidate.includes(REASON),
					"the whole reason under the field",
				);
				expect(frameText(reasonRow(frame)).trim()).toBe(`Error: Context: ${REASON}`);
			},
		);
	});

	test("a Text field cuts a reason to its own cells when its surface names no width", async () => {
		const cells = ownNoteCells(10, 16);
		await withField(
			createElement(TextField, {
				label: "Context",
				value: "272000",
				focused: true,
				width: 16,
				labelWidth: 10,
				error: REASON,
			}),
			120,
			6,
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(candidate) => candidate.includes("Error: Context:"),
					"the reason under the field",
				);
				expect(frameText(reasonRow(frame)).trim()).toBe(
					`Error: Context: ${REASON}`.slice(0, cells).trim(),
				);
			},
		);
	});

	test("a Type-ahead row writes the reason its surface gives it", async () => {
		await withField(
			createElement(TypeAheadRow, {
				label: "Model",
				value: "gpt-4o",
				options: ["anthropic/claude-sonnet-4-5"],
				focused: true,
				width: 20,
				labelWidth: 10,
				warning: true,
				error: REASON,
				noteWidth: 116,
			}),
			120,
			8,
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(candidate) => candidate.includes(REASON),
					"the reason under the value the row stands on",
				);
				expect(frameText(reasonRow(frame)).trim()).toBe(`Error: Model: ${REASON}`);
			},
		);
	});

	test("a selector row keeps an unconfirmed value in the tone it cannot judge", async () => {
		await withField(
			createElement(
				"box",
				{ style: { flexDirection: "column" } },
				createElement(ChoiceRow, {
					key: "waiting",
					label: "Model",
					value: "openai/gpt-4o",
					focused: false,
					width: 24,
					labelWidth: 10,
					pending: true,
				}),
				createElement(ChoiceRow, {
					key: "confirmed",
					label: "Model",
					value: "openai/gpt-5",
					focused: false,
					width: 24,
					labelWidth: 10,
				}),
			),
			60,
			6,
			async (setup) => {
				const frame = await awaitFrame(
					setup,
					(candidate) => candidate.includes("openai/gpt-4o") && candidate.includes("openai/gpt-5"),
					"both rows of the pair",
				);
				expect(frameText(frame)).toContain("Model openai/gpt-4o");
				// A value the row cannot yet judge keeps the tone of a hint, while
				// the confirmed one beside it keeps the tone of a value.
				expect(spanColors(setup, "openai/gpt-4o")).toEqual([rgb(COLORS.dim)]);
				expect(spanColors(setup, "openai/gpt-5")).toEqual([rgb(COLORS.text)]);
			},
		);
	});
});
