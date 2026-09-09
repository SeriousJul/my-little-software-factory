/**
 * The shared editable fields: the Text field and the Draft field.
 *
 * Every control-plane surface that takes operator text uses one of these two
 * modules. The library owns the behavior an operator depends on: the visible
 * label, the focus marker, the caret and selection, standard movement and word
 * editing, backward and forward deletion, undo and redo, safe bracketed paste,
 * the written error line, and the field's own scroll. A caller supplies its
 * label, its value, its validation words, and its domain action; it never
 * touches a renderer buffer, a keyboard subscription, or a caret.
 *
 * The two kinds differ in exactly one editing rule. A Text field holds one
 * line, so Enter submits it. A Draft field holds the operator's own lines, so
 * Enter inserts a newline and submission belongs to a visible action the
 * operator reaches with Tab: an ordinary editing key never starts Agent work
 * on its own. A Draft field also keeps an oversized draft editable and states
 * its size and limit, because silently cutting the text would send the Agent an
 * instruction the operator never approved.
 *
 * Paste is text entry, never an instruction: a pasted newline or a pasted
 * shortcut letter enters the field's text rather than submitting a form or
 * moving the selection, and a field that takes digits only refuses a paste
 * holding any non-digit as one operation, leaving the previous value, the
 * caret, the selection, and the undo history exactly as they were.
 */
import {
	type ContentChangeEvent,
	decodePasteBytes,
	type InputRenderable,
	type KeyEvent,
	type PasteEvent,
	stripAnsiSequences,
	type TextareaRenderable,
} from "@opentui/core";
import { createElement, useRenderer } from "@opentui/react";
import { Fragment, type ReactElement, type RefObject, useCallback, useEffect, useRef } from "react";

import { padToWidth, truncateToWidth, widthOf } from "../text.ts";
import { type ControlInk, controlInk, MARKER_WIDTH, markerText } from "./presentation.ts";

/** The library's own view of the two primitives it wraps. */
type FieldNode = InputRenderable | TextareaRenderable;

/** The undo and redo keys of both field kinds. */
const FIELD_KEY_BINDINGS = [
	{ name: "z", ctrl: true, action: "undo" },
	{ name: "y", ctrl: true, action: "redo" },
	{ name: "z", ctrl: true, shift: true, action: "redo" },
];

/**
 * The same keys, plus the modified-Enter submit a Draft field may offer.
 *
 * The binding is a supplement only: the visible Send and Launch actions stay
 * the route every operator can reach without an enhanced keyboard protocol.
 */
const DRAFT_SUBMIT_BINDINGS = [
	...FIELD_KEY_BINDINGS,
	{ name: "return", ctrl: true, action: "submit" },
];

/** What a refused edit costs the operator, in the surface's own words. */
export interface FieldRefusals {
	/** Why one typed character was refused. */
	character: string;
	/** Why a whole paste was refused. */
	paste: string;
}

/** What one field can do for the surface that holds it. */
export interface FieldHandle {
	/** The exact text the field holds. */
	value(): string;
	/** The offset the next edit lands at. */
	caret(): number;
	/** The whole selected text, or `""` when nothing is selected. */
	selection(): string;
	/** Whether the field holds a selection the operator could copy. */
	hasSelection(): boolean;
	/** Put the selected text where the terminal can receive it. */
	copySelection(): FieldCopyResult;
	/** Give the field the keyboard again, keeping its caret and history. */
	focus(): void;
	/** Take the keyboard away, keeping the text, the caret, and the undo history. */
	blur(): void;
	/** Replace the whole text, keeping the caret inside it. */
	setValue(value: string): void;
}

/** Why a Copy selection action ended the way it did, in operator words. */
export type FieldCopyResult =
	| { kind: "copied"; text: string; reason: string }
	| { kind: "empty"; reason: string }
	| { kind: "unsupported"; text: string; reason: string };

/** The facts a field reports after it changed. */
export interface FieldFacts {
	/** The text the field holds now. */
	value: string;
	/** The offset the next edit lands at. */
	caret: number;
	/** The whole selected text, or `""` when nothing is selected. */
	selection: string;
}

/** The reason a Copy action says what it says. */
const COPY_EMPTY_REASON = "Nothing is selected to copy";
const COPY_UNSET_REASON = "The terminal refused the copied text";

/** The refusal a field states when its caller names none. */
const PLAIN_REFUSALS: FieldRefusals = {
	character: "This field takes digits only",
	paste: "This field takes digits only: the pasted text was refused as a whole",
};

/**
 * The one character a key types, or `null` when it types nothing.
 *
 * A named key arrives as its word or as a multi-cell escape sequence, so a
 * single printed cell is the only thing a field's own rule has to judge.
 */
function typedCharacter(key: KeyEvent): string | null {
	const raw = key.sequence === "" ? key.name : key.sequence;
	if (raw === " ") return " ";
	if (raw.length !== 1) return null;
	const code = raw.charCodeAt(0);
	return code > 0x20 && code < 0x7f ? raw : null;
}

/** The text a paste event carries, with the terminal's own styling removed. */
function pastedText(event: PasteEvent): string {
	return stripAnsiSequences(decodePasteBytes(event.bytes));
}

/** The whole text of one field node. */
function nodeValue(node: FieldNode | null): string {
	return node === null ? "" : node.plainText;
}

/** The text between the selection's two ends, or `""` when it holds none. */
function nodeSelection(node: FieldNode | null): string {
	if (node === null || !node.hasSelection()) return "";
	const range = node.getSelection();
	return range === null ? "" : node.getTextRange(range.start, range.end);
}

/**
 * Fold a field's own text to a value's one spelling.
 *
 * A fold only ever removes characters the operator already typed, and always
 * from one run inside the text, so the library deletes that run in place: the
 * undo history and the rest of the text stay where the operator left them, and
 * the caret steps back over the run so the next edit still lands where it was
 * going to. A fold the field cannot express as one run is a rule the caller
 * invented wrong, so the text stands unchanged.
 */
function foldNodeText(node: FieldNode, folded: string): void {
	const before = node.plainText;
	const caret = node.cursorOffset;
	let start = 0;
	while (start < before.length && start < folded.length && before[start] === folded[start]) {
		start += 1;
	}
	let end = 0;
	while (
		end < before.length - start &&
		end < folded.length - start &&
		before[before.length - 1 - end] === folded[folded.length - 1 - end]
	) {
		end += 1;
	}
	if (folded.slice(start, folded.length - end) !== "") return;
	node.setSelection(start, before.length - end);
	node.deleteSelection();
	node.cursorOffset = Math.min(
		node.plainText.length,
		Math.max(0, caret - (before.length - end - start)),
	);
	node.requestRender();
}

/** The marker and label cells a field paints in front of its value. */
function fieldLabelCells(props: SharedFieldProps, ink: ControlInk): ReactElement[] {
	const marked = props.marked !== false;
	const labelWidth = props.labelWidth ?? Math.max(1, widthOf(props.label) + 1);
	const cells: ReactElement[] = [];
	if (marked) {
		cells.push(
			createElement(
				"text",
				{
					key: "marker",
					fg: props.focused ? (ink.focusedText.fg ?? undefined) : (ink.detail.fg ?? undefined),
				},
				markerText(props.focused),
			),
		);
	}
	cells.push(
		createElement(
			"text",
			{
				key: "label",
				fg: props.focused ? (ink.focusedText.fg ?? undefined) : (ink.detail.fg ?? undefined),
			},
			padToWidth(truncateToWidth(`${props.label} `, labelWidth), labelWidth),
		),
	);
	return cells;
}

/** The written lines a field paints under its value. */
function fieldNoteRows(
	props: SharedFieldProps,
	ink: ControlInk,
	oversize: string | null,
): ReactElement[] {
	const noteWidth = MARKER_WIDTH + (props.labelWidth ?? widthOf(props.label) + 1) + props.width;
	const reason = props.error ?? oversize;
	const rows: ReactElement[] = [];
	if (reason !== null && reason !== undefined) {
		rows.push(
			createElement(
				"text",
				{ key: "error", style: { width: "100%", height: 1 }, fg: ink.error.fg ?? undefined },
				truncateToWidth(`Error: ${props.label}: ${reason}`, noteWidth),
			),
		);
	}
	if (props.hint !== null && props.hint !== undefined) {
		rows.push(
			createElement(
				"text",
				{ key: "hint", style: { width: "100%", height: 1 }, fg: ink.detail.fg ?? undefined },
				truncateToWidth(props.hint, noteWidth),
			),
		);
	}
	return rows;
}

interface SharedFieldProps {
	/** The field's name, taken from the project glossary. Always visible. */
	label: string;
	/** The field holds the keyboard: it paints the marker and takes typing. */
	focused: boolean;
	/** The cells the field's value column holds. */
	width: number;
	/** The cells the shared label column holds. Defaults to the label's own width. */
	labelWidth?: number;
	/** Whether the row carries the focus marker column. Default: true. */
	marked?: boolean;
	/** The dim text a field shows while it holds nothing. */
	placeholder?: string;
	/** The written guide line under the field. */
	hint?: string | null;
	/** Why the field's current value cannot be used, in the caller's words. */
	error?: string | null;
	/** False while a surface above this field owns the keys. Default: true. */
	inputActive?: boolean;
	/** The rule this field refuses edits against, and the words it says. */
	refusals?: FieldRefusals;
	/** The surface's own handle, so its actions can reach the editing state. */
	fieldRef?: RefObject<FieldHandle | null>;
	/** Reports a refused edit or a refused paste on the surface's Message line. */
	onRefuse?: (reason: string) => void;
	/** Reports every text change, with the caret and selection it left behind. */
	onValueChange?: (facts: FieldFacts) => void;
}

/**
 * The editing behavior both field kinds share.
 *
 * This is the one place a key or a paste is judged against a field's own rule,
 * so a fix to the caret or to paste safety reaches the override panel, the
 * Consultation launcher, and the response editor together.
 */
function useFieldEditing(
	node: RefObject<FieldNode | null>,
	props: {
		digits?: boolean;
		normalize?: (value: string) => string;
		refusals?: FieldRefusals;
		onRefuse?: (reason: string) => void;
		onValueChange?: (facts: FieldFacts) => void;
	},
): {
	keyDown: (key: KeyEvent) => void;
	paste: (event: PasteEvent) => void;
	changed: () => void;
	handle: RefObject<FieldHandle | null>;
} {
	const renderer = useRenderer();
	const digits = props.digits === true;
	const normalize = props.normalize;
	const refuse = props.onRefuse;
	const report = props.onValueChange;
	const words = props.refusals ?? PLAIN_REFUSALS;

	const keyDown = useCallback(
		(key: KeyEvent) => {
			if (!digits || key.ctrl || key.meta || key.super || key.hyper) return;
			const character = typedCharacter(key);
			if (character === null || /^[0-9]$/u.test(character)) return;
			// The refused character never reaches the buffer, so the value, the
			// caret, the selection, and the undo history all stay as they were.
			key.preventDefault();
			refuse?.(words.character);
		},
		[digits, refuse, words],
	);

	const paste = useCallback(
		(event: PasteEvent) => {
			if (!digits) return;
			const text = pastedText(event);
			if (/^[0-9]*$/u.test(text)) return;
			// The whole run is refused, so `1e3` can never become `13`.
			event.preventDefault();
			refuse?.(words.paste);
		},
		[digits, refuse, words],
	);

	const changed = useCallback(() => {
		const field = node.current;
		if (field === null) return;
		const before = field.plainText;
		const folded = normalize === undefined ? before : normalize(before);
		if (folded !== before) foldNodeText(field, folded);
		report?.({
			value: field.plainText,
			caret: field.cursorOffset,
			selection: nodeSelection(field),
		});
	}, [normalize, node, report]);

	const handle = useRef<FieldHandle | null>(null);
	handle.current = {
		value: () => nodeValue(node.current),
		caret: () => node.current?.cursorOffset ?? 0,
		selection: () => nodeSelection(node.current),
		hasSelection: () => nodeSelection(node.current) !== "",
		copySelection: () => {
			const text = nodeSelection(node.current);
			if (text === "") return { kind: "empty", reason: COPY_EMPTY_REASON };
			if (!renderer.copyToClipboardOSC52(text)) {
				return { kind: "unsupported", text, reason: COPY_UNSET_REASON };
			}
			return {
				kind: "copied",
				text,
				reason: `Copied ${widthOf(text)} cells of selected text`,
			};
		},
		focus: () => node.current?.focus(),
		blur: () => node.current?.blur(),
		setValue: (value: string) => {
			const field = node.current;
			if (field === null) return;
			field.setText(value);
			field.cursorOffset = Math.min(value.length, field.cursorOffset);
			field.requestRender();
		},
	};
	return { keyDown, paste, changed, handle };
}

export interface TextFieldProps extends SharedFieldProps {
	/** The value the field starts on. */
	value: string;
	/** The field takes digits and nothing else, typed or pasted. */
	digits?: boolean;
	/** The one spelling of an accepted value, applied as the operator types. */
	normalize?: (value: string) => string;
	/** The largest value the field holds. */
	maxLength?: number;
	/** Enter on a Text field submits it. A Draft field never takes this. */
	onSubmit?: (value: string) => void;
}

/** The Text field: one line of operator text, edited the same way everywhere. */
export function TextField(props: TextFieldProps): ReactElement {
	const ink = controlInk();
	const node = useRef<InputRenderable | null>(null);
	const { keyDown, paste, changed, handle } = useFieldEditing(node, {
		digits: props.digits,
		normalize: props.normalize,
		refusals: props.refusals,
		onRefuse: props.onRefuse,
		onValueChange: props.onValueChange,
	});
	if (props.fieldRef !== undefined) props.fieldRef.current = handle.current;
	// A value the caller cannot use is the field's own news, so the field wears
	// it: the written error line states the reason, and the tone only agrees with
	// what is already written beside it.
	const tint = props.error === null || props.error === undefined ? null : ink.warning.fg;
	return createElement(
		Fragment,
		{},
		createElement(
			"box",
			{ key: "row", style: { flexDirection: "row", height: 1 } },
			...fieldLabelCells(props, ink),
			createElement("input", {
				ref: node,
				width: Math.max(1, props.width),
				value: props.value,
				focused: props.focused && props.inputActive !== false,
				placeholder: props.placeholder ?? "",
				placeholderColor: ink.detail.fg ?? undefined,
				textColor: tint ?? ink.text.fg ?? undefined,
				focusedTextColor: tint ?? ink.focusedText.fg ?? undefined,
				backgroundColor: "transparent",
				focusedBackgroundColor: ink.surface.on === "default" ? "transparent" : ink.surface.on,
				cursorColor: ink.indicator.fg ?? undefined,
				// A blinking caret is never required to see where the next edit
				// lands, so the field paints a steady one by default.
				cursorStyle: { style: "line", blinking: false },
				// A bar cursor and boundary selection agree: one shift-arrow moves
				// the selection over exactly one grapheme, so the text the operator
				// sees selected is the text a copy or a replacement edit uses.
				selectionOccupancy: "boundary",
				maxLength: props.maxLength ?? 1000,
				keyBindings: FIELD_KEY_BINDINGS,
				onKeyDown: keyDown,
				onPaste: paste,
				onInput: changed,
				onSubmit: props.onSubmit,
			}),
		),
		...fieldNoteRows(props, ink, null),
	);
}

export interface DraftFieldProps extends SharedFieldProps {
	/** The draft the field starts on. */
	value: string;
	/** The rows the field paints; its text scrolls inside them. */
	height: number;
	/** Why the field's text is too large to send, in the caller's words. */
	oversize?: (value: string) => string | null;
	/** A modified-Enter submit, offered as a supplement to the visible action. */
	onSubmit?: (value: string) => void;
}

/** The Draft field: the operator's own lines, addressed to an Agent. */
export function DraftField(props: DraftFieldProps): ReactElement {
	const ink = controlInk();
	const node = useRef<TextareaRenderable | null>(null);
	const { keyDown, paste, changed, handle } = useFieldEditing(node, {
		refusals: props.refusals,
		onRefuse: props.onRefuse,
		onValueChange: props.onValueChange,
	});
	if (props.fieldRef !== undefined) props.fieldRef.current = handle.current;
	// A draft larger than its limit stays editable and says so: the operator has
	// to shorten it, and a silently cut draft would hand the Agent an
	// instruction nobody approved.
	const oversizeReason = props.oversize?.(props.value) ?? null;
	const tint =
		(props.error ?? oversizeReason) === null || (props.error ?? oversizeReason) === undefined
			? null
			: ink.warning.fg;
	const reported = useRef(props.value);
	// A draft the field starts on is the operator's own unfinished text. The
	// caret opens at its end when the whole draft fits the rows the field was
	// given, because that is where the next line belongs. A draft larger than
	// the field opens at its start instead: the visible caret and the next edit
	// must agree, and a caret parked past the field's last row would point at
	// text the operator cannot see.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the opening caret is a mount decision; the operator's own keys decide where it goes after that, and a resize must never move it
	useEffect(() => {
		const field = node.current;
		if (field === null) return;
		if (field.virtualLineCount <= Math.max(1, props.height)) {
			field.cursorOffset = field.plainText.length;
		} else {
			field.gotoBufferHome();
		}
		field.requestRender();
		// The rows are read once at mount: the operator's own keys decide where
		// the caret goes after that, and a resize never moves it for them.
	}, []);
	const content = useCallback(
		(_event: ContentChangeEvent) => {
			changed();
			reported.current = nodeValue(node.current);
		},
		[changed],
	);
	// A caller owns its draft's storage, so a draft it restores from outside -
	// a reopened response editor, a delivery the Agent refused - is the field's
	// own text now. The field's text already matches what it reported last, so
	// an edit the operator made never round-trips back through this write.
	useEffect(() => {
		const field = node.current;
		if (field === null || props.value === reported.current) return;
		field.setText(props.value);
		field.cursorOffset = Math.min(props.value.length, field.cursorOffset);
		reported.current = props.value;
		field.requestRender();
	}, [props.value]);
	return createElement(
		Fragment,
		{},
		createElement(
			"box",
			{ key: "field", style: { flexDirection: "column" } },
			createElement(
				"box",
				{ key: "label", style: { flexDirection: "row", height: 1 } },
				...fieldLabelCells(props, ink),
			),
			createElement("textarea", {
				ref: node,
				width: Math.max(1, props.width),
				height: Math.max(1, props.height),
				initialValue: props.value,
				focused: props.focused && props.inputActive !== false,
				placeholder: props.placeholder ?? "",
				placeholderColor: ink.detail.fg ?? undefined,
				textColor: tint ?? ink.text.fg ?? undefined,
				focusedTextColor: tint ?? ink.focusedText.fg ?? undefined,
				backgroundColor: "transparent",
				focusedBackgroundColor: ink.surface.on === "default" ? "transparent" : ink.surface.on,
				cursorColor: ink.indicator.fg ?? undefined,
				selectionBg: ink.selectionBackground.fg ?? undefined,
				selectionFg: ink.selectionText.fg ?? undefined,
				cursorStyle: { style: "line", blinking: false },
				selectionOccupancy: "boundary",
				wrapMode: "word",
				keyBindings: props.onSubmit === undefined ? FIELD_KEY_BINDINGS : DRAFT_SUBMIT_BINDINGS,
				onKeyDown: keyDown,
				onPaste: paste,
				onContentChange: content,
				onSubmit:
					props.onSubmit === undefined
						? undefined
						: () => props.onSubmit?.(nodeValue(node.current)),
			}),
		),
		...fieldNoteRows(props, ink, oversizeReason),
	);
}
