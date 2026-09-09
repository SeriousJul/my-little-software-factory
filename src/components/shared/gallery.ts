/**
 * The shared control gallery: every shared control, in every state it draws.
 *
 * The gallery is a real application run against the production modules, not a
 * picture of them. It opens on the first example and answers the keys the
 * control plane answers with, so a contributor can exercise a field's caret,
 * paste, focus, and refusal before wiring it into a screen, and an automated
 * test can drive the same example the operator sees.
 *
 * Each example names its own state, because the standard requires the gallery to
 * show a control normal, focused, invalid, unavailable, loading, and narrow: an
 * example that only looks like the happy path teaches nothing about the edge
 * that made the control worth sharing.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { useControlDispatch } from "../control-dispatch.ts";
import { contextFor } from "../controls.ts";
import { type ActionRow, MARKER_WIDTH, ModalSurface, modalFrame } from "../modal-chrome.ts";
import { truncateToWidth } from "../text.ts";
import { COLORS } from "../theme.ts";
import { ActionItem, ChoiceRow } from "./choices.ts";
import { DraftField, type FieldHandle, TextField } from "./fields.ts";
import { moveFieldWith, useFormSlots } from "./form.ts";
import { controlInk, STATE_WORDS } from "./presentation.ts";
import { TypeAheadRow } from "./type-ahead.ts";

/** One example of the gallery: a title, a state word, and the controls it shows. */
export interface GalleryExample {
	id: string;
	/** What the example is, in the words an operator reads on the row. */
	state: string;
	/**
	 * The example's controls at one set of columns.
	 *
	 * `holds` names the control the example shows focused - one control per
	 * example, because a form owns the keyboard through exactly one slot - and
	 * `inputActive` is whether the gallery's own surface holds the keys, so a
	 * test can draw the focused-capture case without a second implementation.
	 */
	render: (columns: GalleryColumns, holds: string, inputActive: boolean) => ReactElement[];
	/** Whether this example is drawn at a narrow terminal. */
	narrow?: boolean;
}

/** The columns one example lays its controls out in. */
export interface GalleryColumns {
	contentWidth: number;
	labelWidth: number;
	valueWidth: number;
}

/** The control each example shows focused: one per example, as a form holds. */
const FOCUSED_CONTROL: Record<string, string> = {
	fields: "context",
	states: "launch",
	search: "type-ahead",
	narrow: "draft",
};

/** The Model list the Type-ahead examples search. */
export const GALLERY_MODELS = [
	"anthropic/claude-sonnet-4-5",
	"openai/gpt-5.1",
	"openai/gpt-5.1-codex",
];

/** The columns one terminal width gives the gallery. */
export function galleryColumns(contentWidth: number): GalleryColumns {
	const labelWidth = Math.min(14, Math.max(1, contentWidth - 12));
	return {
		contentWidth,
		labelWidth,
		valueWidth: Math.max(1, contentWidth - labelWidth - MARKER_WIDTH),
	};
}

/**
 * The examples the gallery shows, in the order Tab walks them.
 *
 * One entry per state the standard names, so the list is also the checklist a
 * review reads: normal, focused, invalid, unavailable, loading, and narrow.
 */
export const GALLERY_EXAMPLES: readonly GalleryExample[] = [
	{
		id: "fields",
		state: "normal and focused",
		render: (columns, holds, inputActive) => [
			createElement(TextField, {
				key: "model",
				label: "Model",
				value: "openai/gpt-5.1",
				focused: holds === "model",
				inputActive,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				hint: "a Text field: one line, Enter submits",
			}),
			createElement(TextField, {
				key: "context",
				label: "Context",
				value: "272000",
				focused: holds === "context",
				inputActive,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				digits: true,
				refusals: {
					character: "This field takes digits only",
					paste: "This field takes digits only: the pasted text was refused as a whole",
				},
				hint: "the focused field: digits only, a paste is refused whole",
			}),
			createElement(DraftField, {
				key: "draft",
				label: "Initial input",
				value: "first line of a draft\nsecond line stays",
				focused: holds === "draft",
				inputActive,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				height: 3,
				hint: "a Draft field: Enter adds a line, an action sends it",
			}),
		],
	},
	{
		id: "states",
		state: "invalid, unavailable, and loading",
		render: (columns, holds, _inputActive) => [
			createElement(TextField, {
				key: "invalid",
				label: "Context",
				value: "0",
				focused: holds === "invalid",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				error: "0 is not a positive whole number of tokens in digits",
			}),
			createElement(ChoiceRow, {
				key: "unavailable",
				label: "Repository",
				value: "",
				focused: holds === "unavailable",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				placeholder: STATE_WORDS.unavailable,
				error: "no verified Repository is available",
			}),
			createElement(ChoiceRow, {
				key: "loading",
				label: "Model",
				value: "",
				focused: holds === "loading",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				placeholder: STATE_WORDS.loading,
			}),
			createElement(
				"box",
				{ key: "actions", style: { flexDirection: "column" } },
				createElement(ActionItem, {
					row: { key: "launch", label: "Launch Consultation" } satisfies ActionRow,
					focused: holds === "launch",
					width: columns.contentWidth,
					refusal: "initial input cannot be empty",
				}),
			),
		],
	},
	{
		id: "search",
		state: "Type-ahead search",
		render: (columns, holds, inputActive) => [
			createElement(GalleryTypeAhead, {
				key: "type-ahead",
				initial: "openai/gpt-5.1",
				focused: holds === "type-ahead",
				inputActive,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
			}),
		],
	},
	{
		id: "narrow",
		state: "narrow terminal",
		narrow: true,
		render: (columns, holds, _inputActive) => [
			createElement(TextField, {
				key: "model",
				label: "Model",
				value: "anthropic/claude-sonnet-4-5-with-a-long-tail",
				focused: holds === "model",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
			}),
			createElement(DraftField, {
				key: "draft",
				label: "Initial input",
				value: "a draft wide enough that its own column has to scroll to the caret",
				focused: holds === "draft",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				height: 2,
			}),
		],
	},
];

/**
 * The gallery's Type-ahead example, with the value the search names.
 *
 * The row is the production module; only the small owner of the selected value
 * is gallery code, because that is the part a screen keeps for itself. A
 * contributor who exercises the search here drives the same callback the
 * override panel wires.
 */
function GalleryTypeAhead(props: {
	initial: string;
	focused: boolean;
	inputActive: boolean;
	width: number;
	labelWidth: number;
}): ReactElement {
	// The screen owns the value a search names, so the example owns it here: the
	// gallery is the screen in this program, exactly as the panel is in that one.
	const [value, setValue] = useState(props.initial);
	return createElement(TypeAheadRow, {
		label: "Model",
		value,
		options: GALLERY_MODELS,
		focused: props.focused && props.inputActive,
		inputActive: props.inputActive,
		width: props.width,
		labelWidth: props.labelWidth,
		placeholder: STATE_WORDS.unset,
		onQueryChange: (_query, match) => {
			if (match.first !== undefined) setValue(match.first);
		},
	});
}

interface GalleryProps {
	/** The example to open on, so a test or a contributor lands on one state. */
	example?: string;
	/** Take the keys away from the fields, as a surface above them does. */
	inputActive?: boolean;
	onEmergencyExit: () => void;
}

/**
 * The gallery surface: one example at a time, with the shared chrome around it.
 *
 * Tab walks the examples; the surface's own keys come from the same catalogue
 * every control-plane screen uses, so what a contributor exercises here is the
 * dispatch and the Action bar the application runs.
 */
export function Gallery({
	example,
	inputActive = true,
	onEmergencyExit,
}: GalleryProps): ReactElement {
	const { width, height } = useTerminalDimensions();
	const ids = GALLERY_EXAMPLES.map((entry) => entry.id);
	const [index, setIndex] = useState(Math.max(0, ids.indexOf(example ?? ids[0])));
	const indexRef = useRef(index);
	const field = useRef<FieldHandle | null>(null);
	const slots = GALLERY_EXAMPLES.map((entry) => ({
		id: entry.id,
		kind: "field" as const,
		label: entry.state,
	}));
	const focus = useFormSlots(slots);
	const _moveField = moveFieldWith(focus);
	const ink = controlInk();
	// The gallery's own keys come from the same catalogue the application runs,
	// so a contributor exercises the real dispatch and the real Action bar.
	useControlDispatch({
		mode: "form-field",
		context: contextFor("form-field", {
			listCanMove: false,
			detailCanScroll: false,
			sourceCount: 0,
			refreshingSourceCount: 0,
			handoffActive: false,
			messageTruncated: false,
			consultationTypesConfigured: true,
			fieldHasSelection: field.current?.hasSelection() === true,
		}),
		onEmergencyExit,
		handlers: {
			"move-field": ({ key }) => {
				const next = (indexRef.current + (key.shift === true ? -1 : 1) + ids.length) % ids.length;
				indexRef.current = next;
				setIndex(next);
				focus.move(key.shift === true ? -1 : 1);
				key.preventDefault?.();
			},
			"copy-selection": ({ key }) => {
				const result = field.current?.copySelection();
				if (result !== undefined) key.preventDefault?.();
			},
		},
	});
	const shown = GALLERY_EXAMPLES[index] ?? GALLERY_EXAMPLES[0];
	const narrow = shown.narrow === true;
	const frame = modalFrame(narrow ? 28 : width, height, { rows: 12, margin: 1 });
	const columns = galleryColumns(frame.contentWidth);
	return createElement(ModalSurface, {
		frame,
		width: narrow ? 28 : width,
		title: `Shared controls - ${shown.state}`,
		borderColor: ink.indicator.fg ?? COLORS.borderFocused,
		minContentRows: 3,
		message: null,
		bar: {
			mode: "form-field",
			context: contextFor("form-field", {
				listCanMove: false,
				detailCanScroll: false,
				sourceCount: 0,
				refreshingSourceCount: 0,
				handoffActive: false,
				messageTruncated: false,
				consultationTypesConfigured: true,
				fieldHasSelection: false,
			}),
		},
		children: [
			createElement(
				"text",
				{ key: "state", fg: ink.detail.fg ?? undefined },
				truncateToWidth(
					`state: ${shown.state}  (Tab shows the next example; ${ids.length} in all)`,
					frame.contentWidth,
				),
			),
			...shown.render(columns, FOCUSED_CONTROL[shown.id] ?? shown.id, inputActive),
		],
	});
}
