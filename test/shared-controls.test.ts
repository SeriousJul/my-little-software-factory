/** Shared fields expose one editing baseline to every control-plane caller. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactElement, type RefObject, useEffect, useState } from "react";

import { ChoiceRow } from "../src/components/shared/choices.ts";
import {
	DraftField,
	type FieldFacts,
	type FieldHandle,
	TextField,
} from "../src/components/shared/fields.ts";
import { NO_COLOR_INK, ownNoteCells } from "../src/components/shared/presentation.ts";
import {
	SPINNER_FRAME_MS,
	SPINNER_FRAMES,
	Spinner,
	spinnerFace,
	useSpinnerFrame,
} from "../src/components/shared/spinner.ts";
import { TypeAheadRow } from "../src/components/shared/type-ahead.ts";
import {
	fieldKey,
	frameText,
	frameUntil,
	pasteText,
	rgb,
	roleColor,
	rowsOf,
	sleep,
	spanColors,
	typeText,
	waitFor,
} from "./app-harness.ts";

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
	fields: {
		height: number;
		body: (setup: Awaited<ReturnType<typeof testRender>>) => Promise<void>;
		enhancedKeys?: boolean;
	},
): Promise<void> {
	const { height, body, enhancedKeys = false } = fields;
	const setup = await testRender(element, { width, height, kittyKeyboard: enhancedKeys });
	await setup.flush();
	renderer = setup.renderer;
	await body(setup);
}

/** The paint a test uses to be the caller that hands a Draft field a draft. */
let paintDraft: ((value: string) => void) | null = null;

/**
 * The caller side of a Draft field: the draft a screen stores, and the paint it
 * gives back to the field.
 *
 * A screen that stores what its field reports paints that text at the field on
 * its next render, and a render can land after the operator has typed past it.
 * `paintDraft` is how a test plays that late render.
 */
function DraftHost(props: {
	initial: string;
	fieldRef: RefObject<FieldHandle | null>;
}): ReactElement {
	const [draft, setDraft] = useState(props.initial);
	useEffect(() => {
		paintDraft = setDraft;
		return () => {
			paintDraft = null;
		};
	}, []);
	return createElement(
		"box",
		{ style: { flexDirection: "column" } },
		createElement(DraftField, {
			label: "Response draft",
			value: draft,
			focused: true,
			width: 32,
			height: 4,
			fieldRef: props.fieldRef,
		}),
	);
}

/** Mount one Draft field over its caller, and hand the test both handles. */
async function withDraftHost(initial: string): Promise<{
	setup: Awaited<ReturnType<typeof testRender>>;
	field: RefObject<FieldHandle | null>;
}> {
	const field: RefObject<FieldHandle | null> = { current: null };
	const setup = await testRender(createElement(DraftHost, { initial, fieldRef: field }), {
		width: 40,
		height: 10,
	});
	await setup.flush();
	renderer = setup.renderer;
	return { setup, field };
}

describe("the shared Draft field", () => {
	test("paints its visible label and keeps Enter as a newline", async () => {
		const onValueChange = mock();
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
			{
				height: 10,
				body: async (setup) => {
					expect(frameText(setup.captureCharFrame())).toContain("Initial input");
					fieldKey(setup, "left");
					fieldKey(setup, "enter");
					await frameUntil(setup, "Enter to insert a newline at the caret", () =>
						onValueChange.mock.calls.some(
							([facts]) => (facts as FieldFacts).value === "review desig\nn",
						),
					);
				},
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
			{
				height: 6,
				body: async (setup) => {
					await typeText(setup, "anthropic/sonnet");
					fieldKey(setup, "home");
					fieldKey(setup, "shift+right");
					fieldKey(setup, "shift+right");
					fieldKey(setup, "shift+right");
					const frame = await frameUntil(
						setup,
						"a three-cell selection",
						() => field.current?.selection() === "ant",
					);
					expect(field.current?.caret()).toBe(3);
					// A Key guide above the field takes the keys: the editing state the
					// operator left behind is still there when the field gets them back.
					field.current?.blur();
					typeText(setup, "x");
					await setup.flush();
					expect(field.current?.value()).toBe("anthropic/sonnet");
					field.current?.focus();
					expect(field.current?.selection()).toBe("ant");
					expect(field.current?.caret()).toBe(3);
					// Typing replaces the selected text, and undo gives it back.
					typeText(setup, "q");
					await frameUntil(
						setup,
						"the typed character to replace the selection",
						() => field.current?.value() === "qhropic/sonnet",
					);
					// Replacing a selection is two operations, so undo steps back
					// through them one at a time: the character the operator typed, then
					// the text that character replaced.
					fieldKey(setup, "ctrl+z");
					await frameUntil(
						setup,
						"undo to take the typed character back out",
						() => field.current?.value() === "hropic/sonnet",
					);
					fieldKey(setup, "ctrl+z");
					await frameUntil(
						setup,
						"the second undo to give the replaced text back",
						() => field.current?.value() === "anthropic/sonnet",
					);
					expect(frameText(frame)).toContain("Model");
				},
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
			{
				height: 10,
				body: async (setup) => {
					fieldKey(setup, "ctrl+a");
					await frameUntil(
						setup,
						"the whole draft selected",
						() => draft.current?.selection() === "copy this part",
					);
					typeText(setup, "q");
					await frameUntil(
						setup,
						"the typed character to replace the selection",
						() => draft.current?.value() === "q",
					);
				},
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
			{
				height: 10,
				body: async (setup) => {
					fieldKey(setup, "ctrl+a");
					await frameUntil(
						setup,
						"the whole value selected",
						() => text.current?.selection() === "openai/gpt-5.1",
					);
					typeText(setup, "q");
					await frameUntil(
						setup,
						"the typed character to replace the selection",
						() => text.current?.value() === "q",
					);
				},
			},
		);
	});

	test("keeps the text its operator wrote when its caller paints an older draft", async () => {
		const { setup, field } = await withDraftHost("the stored draft");
		await typeText(setup, " then ship it");
		await frameUntil(
			setup,
			"the operator's text in the field",
			() => field.current?.value() === "the stored draft then ship it",
		);
		// The caller's late render: the draft the screen stored before the operator's
		// own keys reached it. Writing it into the field would delete the reply the
		// operator just typed.
		act(() => paintDraft?.("an older stored draft"));
		await sleep(150);
		expect(field.current?.value()).toBe("the stored draft then ship it");
		expect(frameText(setup.captureCharFrame())).not.toContain("an older stored draft");
	});

	test("takes the draft its caller paints at it while the operator has written nothing", async () => {
		const { setup, field } = await withDraftHost("");
		act(() => paintDraft?.("a draft the screen restored"));
		await frameUntil(
			setup,
			"the restored draft in the field",
			() => field.current?.value() === "a draft the screen restored",
		);
	});
});

describe("the shared Text field", () => {
	test("refuses a non-digit paste as one operation and states why", async () => {
		const onValueChange = mock();
		const onRefuse = mock();
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
			{
				height: 6,
				body: async (setup) => {
					await pasteText(setup, "1e3");
					const frame = await frameUntil(
						setup,
						"the paste refusal",
						() => onRefuse.mock.calls.length > 0,
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
			},
		);
	});

	test("takes a paste of digits in full, in the same rule that refuses the rest", async () => {
		const onValueChange = mock();
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
			{
				height: 6,
				body: async (setup) => {
					await pasteText(setup, "3456");
					await frameUntil(setup, "the pasted digits to be taken", () =>
						onValueChange.mock.calls.some(([facts]) => (facts as FieldFacts).value === "123456"),
					);
				},
			},
		);
	});

	test("refuses one typed non-digit and keeps the value and the caret", async () => {
		const onRefuse = mock();
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
			{
				height: 6,
				body: async (setup) => {
					fieldKey(setup, "home");
					fieldKey(setup, "right");
					typeText(setup, "x");
					await frameUntil(setup, "the typed refusal", () => onRefuse.mock.calls.length > 0);
					expect(field.current?.value()).toBe("1234");
					expect(field.current?.caret()).toBe(1);
				},
			},
		);
	});

	test("refuses non-ASCII printable characters in a digits field", async () => {
		const onRefuse = mock();
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
			{
				height: 6,
				body: async (setup) => {
					await typeText(setup, "é١");
					await frameUntil(
						setup,
						"both non-ASCII typed refusals",
						() => onRefuse.mock.calls.length === 2,
					);
					expect(onRefuse).toHaveBeenCalledTimes(2);
					expect(field.current?.value()).toBe("12");
				},
			},
		);
	});

	test("refuses a non-digit paste while a selection is held, and keeps the value, the caret, and the selection", async () => {
		const onRefuse = mock();
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
			{
				height: 6,
				body: async (setup) => {
					// Hold a two-cell selection from the start of the value.
					fieldKey(setup, "home");
					fieldKey(setup, "shift+right");
					fieldKey(setup, "shift+right");
					await frameUntil(setup, "the held selection", () => field.current?.selection() === "27");
					await pasteText(setup, "1e3");
					await frameUntil(setup, "the paste refusal", () => onRefuse.mock.calls.length > 0);
					expect(onRefuse).toHaveBeenCalledWith(
						"This field takes digits only: the pasted text was refused as a whole",
					);
					// The refusal was whole: the value, the caret, and the selection all stand.
					expect(field.current?.value()).toBe("272000");
					expect(field.current?.caret()).toBe(2);
					expect(field.current?.selection()).toBe("27");
				},
			},
		);
	});

	test("enforces a stated character limit, and refuses the crossing edit as a whole", async () => {
		const onRefuse = mock();
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
			{
				height: 6,
				body: async (setup) => {
					// A paste that would cross the limit is refused whole, and the row
					// states the limit in the field's own words.
					await pasteText(setup, "12345");
					await waitFor(setup, { shows: "the pasted text was refused as a whole" });
					expect(onRefuse).toHaveBeenCalledWith(
						"This field holds at most 5 characters: the pasted text was refused as a whole",
					);
					expect(field.current?.value()).toBe("abc");
					// Edits that stay inside the limit are taken...
					typeText(setup, "d");
					await frameUntil(
						setup,
						"the edit inside the limit",
						() => field.current?.value() === "abcd",
					);
					typeText(setup, "e");
					await frameUntil(
						setup,
						"the edit that fills the limit",
						() => field.current?.value() === "abcde",
					);
					// ...and the one that crosses it is refused, with the limit stated.
					typeText(setup, "f");
					await frameUntil(setup, "the second refusal", () => onRefuse.mock.calls.length === 2);
					await waitFor(setup, { shows: "This field holds at most 5 characters" });
					expect(onRefuse).toHaveBeenLastCalledWith("This field holds at most 5 characters");
					expect(field.current?.value()).toBe("abcde");
				},
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
			{
				height: 6,
				body: async (setup) => {
					await typeText(setup, "007");
					const _folded = await waitFor(setup, { shows: "Context 7" });
					expect(field.current?.value()).toBe("7");
					expect(field.current?.caret()).toBe(1);
				},
			},
		);
	});
});

describe("both key protocols", () => {
	test("an enhanced terminal's sequences mean the same operations", async () => {
		const onValueChange = mock();
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
			{
				height: 8,
				body: async (setup) => {
					await typeText(setup, "alpha beta");
					const values = () =>
						onValueChange.mock.calls.map(([facts]) => (facts as FieldFacts).value);
					// The caret moves one grapheme left, Enter draws a new line there,
					// and Ctrl+Z takes the new line back: an enhanced terminal changes
					// how a key is encoded, never what the key does.
					fieldKey(setup, "left");
					fieldKey(setup, "enter");
					await frameUntil(setup, "the enhanced Enter to add a line", () =>
						values().includes("alpha bet\na"),
					);
					fieldKey(setup, "ctrl+z");
					await frameUntil(setup, "the enhanced undo", () => values().at(-1) === "alpha beta");
				},
				enhancedKeys: true,
			},
		);
	});

	test("an enhanced terminal keeps a digits field's refusal", async () => {
		const onRefuse = mock();
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
			{
				height: 6,
				body: async (setup) => {
					typeText(setup, "e");
					await frameUntil(setup, "the enhanced refusal", () => onRefuse.mock.calls.length > 0);
					expect(onRefuse).toHaveBeenCalledWith("This field takes digits only");
				},
				enhancedKeys: true,
			},
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
			{
				height: 6,
				body: async (setup) => {
					const frame = await waitFor(setup, { shows: REASON });
					expect(frameText(reasonRow(frame)).trim()).toBe(`Error: Context: ${REASON}`);
				},
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
			{
				height: 6,
				body: async (setup) => {
					const frame = await waitFor(setup, { shows: "Error: Context:" });
					expect(frameText(reasonRow(frame)).trim()).toBe(
						`Error: Context: ${REASON}`.slice(0, cells).trim(),
					);
				},
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
			{
				height: 8,
				body: async (setup) => {
					const frame = await waitFor(setup, { shows: REASON });
					expect(frameText(reasonRow(frame)).trim()).toBe(`Error: Model: ${REASON}`);
				},
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
					muted: true,
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
			{
				height: 6,
				body: async (setup) => {
					const frame = await frameUntil(
						setup,
						"both rows of the pair",
						(candidate) =>
							candidate.includes("openai/gpt-4o") && candidate.includes("openai/gpt-5"),
					);
					expect(frameText(frame)).toContain("Model openai/gpt-4o");
					// A value the row cannot yet judge keeps the tone of a hint, while
					// the confirmed one beside it keeps the tone of a value.
					expect(spanColors(setup, "openai/gpt-4o")).toEqual([rgb(roleColor("subtext0"))]);
					expect(spanColors(setup, "openai/gpt-5")).toEqual([rgb(roleColor("text"))]);
				},
			},
		);
	});
});

describe("the shared spinner", () => {
	test("paints the frame it is named beside its written word, in the tone a state word wears", async () => {
		await withField(createElement(Spinner, { word: "starting", width: 12, frame: 0 }), 30, {
			height: 3,
			body: async (setup) => {
				const frame = await waitFor(setup, { shows: `${SPINNER_FRAMES[0]} starting` });
				// The face holds its slot whole: glyph, a cell of air, the word,
				// padded to the cells the surface names.
				const row = rowsOf(frame).find((line) => line.includes("starting"));
				if (row === undefined) throw new Error("the face never painted its word");
				expect(row.trim()).toBe(`${SPINNER_FRAMES[0]} starting`);
				// The face paints the presentation's detail tone: the tone the
				// shared state words wear, from the Theme in force.
				expect(spanColors(setup, "starting")).toEqual([rgb(roleColor("subtext0"))]);
			},
		});
	});

	test("under the no-color ink keeps its word and drops its color", async () => {
		await withField(
			createElement(Spinner, { word: "starting", width: 12, frame: 2, ink: NO_COLOR_INK }),
			30,
			{
				height: 3,
				body: async (setup) => {
					await waitFor(setup, { shows: `${SPINNER_FRAMES[2]} starting` });
					// The word stands as the whole message. The renderer's own default
					// is the paint, and the default is not a paint: no color of the
					// face's own shows anywhere on the row.
					expect(spanColors(setup, "starting")).toEqual([[255, 255, 255]]);
				},
			},
		);
	});

	test("drives its own frames the way the pop-in drives its own", async () => {
		await withField(createElement(Spinner, { word: "starting", width: 12 }), 30, {
			height: 3,
			body: async (setup) => {
				const first = setup.captureCharFrame();
				const firstGlyph = SPINNER_FRAMES.find((glyph) => first.includes(`${glyph} starting`));
				// The mount paints the face on one of its frames: the first frame
				// on a host fast enough, a later one on a host slow enough for a
				// tick to land before the capture. Never a frame it does not own.
				expect(firstGlyph).toBeDefined();
				// The face steps on its own interval without the renderer's
				// animation engine being asked, so the step shows in the test
				// renderer too.
				await frameUntil(setup, "the face to step to another frame", (candidate) =>
					SPINNER_FRAMES.some(
						(glyph) => glyph !== firstGlyph && candidate.includes(`${glyph} starting`),
					),
				);
			},
		});
	});

	test("owes no motion to a slot that says no face is on screen", async () => {
		// A slot that paints the face as written text asks the shared frame for
		// it, and names the gate: an inactive gate starts no interval at all.
		const StaticFace = (props: { active: boolean }) => {
			const at = useSpinnerFrame(props.active);
			return createElement("text", undefined, spinnerFace(at, "starting", 12));
		};
		await withField(createElement(StaticFace, { active: false }), 30, {
			height: 3,
			body: async (setup) => {
				const first = setup.captureCharFrame();
				expect(first).toContain(`${SPINNER_FRAMES[0]} starting`);
				// Three frame ticks of wall time pass, and the face stands: the gate
				// runs no interval, so nothing can move it.
				await sleep(SPINNER_FRAME_MS * 3);
				expect(setup.captureCharFrame()).toContain(`${SPINNER_FRAMES[0]} starting`);
				expect(setup.captureCharFrame()).toBe(first);
			},
		});
	});
});
