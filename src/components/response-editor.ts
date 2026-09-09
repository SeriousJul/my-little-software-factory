/**
 * The response editor: the operator's reply to a Consultation that waits.
 *
 * The editor is the same shared controls as the Consultation launcher, in the
 * consultations view's own column: one Draft field and two visible actions.
 * Enter inside the field adds a line, so a reply keeps its own paragraphs and
 * no ordinary editing key sends anything on its own. `Send response` is the
 * route, and Tab reaches it.
 *
 * Escape closes the editor and leaves the Response draft saved, which is what
 * the operator's work is worth while the Agent has not taken it. `Discard draft`
 * is the one action that deletes the saved text, and it says so on the row.
 */
import { createElement } from "@opentui/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";

import { validateResponseInput } from "../consultation.ts";
import { useControlDispatch } from "./control-dispatch.ts";
import type { ControlContext } from "./controls.ts";
import { contextFor } from "./controls.ts";
import type { MessageFact } from "./messages.ts";
import { type ActionRow, MARKER_WIDTH } from "./modal-chrome.ts";
import { ActionItem } from "./shared/choices.ts";
import { DraftField, type FieldHandle } from "./shared/fields.ts";
import { type FormFocus, moveFieldWith, useFormSlots } from "./shared/form.ts";
import { controlInk } from "./shared/presentation.ts";
import { truncateToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

interface ResponseEditorProps {
	/** The Response draft the Consultation holds, as the plane saved it. */
	draft: string;
	/** The columns the consultations view gives this panel. */
	width: number;
	/** The rows the consultations view gives this panel, border included. */
	rows: number;
	focused: boolean;
	context: ControlContext;
	/** False while a Key guide or Message view is above this editor. */
	inputActive?: boolean;
	/** Send the draft to the Consultation's Agent. */
	onSend: (text: string) => void;
	/** Delete the saved Response draft. Closing never does this on its own. */
	onDiscard: () => void;
	/** Close the editor with the draft left saved as it stands. */
	onClose: (kept: string) => void;
	onHelp?: () => void;
	onMessage?: () => void;
	onUnavailable?: (reason: string) => void;
	onRefuse?: (reason: string) => void;
	message: MessageFact | null;
	onEmergencyExit: () => void;
}

/** The editor's slots: the reply, then the two actions that end it. */
const SLOTS = [
	{ id: "draft", kind: "field", label: "Response draft" },
	{ id: "send", kind: "action", label: "Send response" },
	{ id: "discard", kind: "action", label: "Discard draft" },
] as const;

/**
 * The rows around the Draft field: its own label and retention line, the two
 * visible actions, the box's two border rows and its padding.
 *
 * The count is what keeps the panel honest. A surface is handed no more rows
 * than it holds, so a row left out of this total would paint through the row
 * below it, and an action the operator cannot see is an action they cannot run.
 */
const FIXED_ROWS = 10;
/** The fewest rows a Draft field is still a Draft field with. */
const MINIMUM_DRAFT_ROWS = 1;

/** The rows the response editor needs to draw itself at all. */
export const RESPONSE_EDITOR_ROWS = FIXED_ROWS + 2;

export function ResponseEditor({
	draft,
	width,
	rows,
	focused,
	context,
	inputActive = true,
	onSend,
	onDiscard,
	onClose,
	onHelp,
	onMessage,
	onUnavailable,
	message,
	onEmergencyExit,
}: ResponseEditorProps): ReactElement {
	const field = useRef<FieldHandle | null>(null);
	const text = useRef(draft);
	const selection = useRef(false);
	const [size, setSize] = useState(draft);
	const focus: FormFocus = useFormSlots(SLOTS);
	const moveField = moveFieldWith(focus);
	const refusal = validateResponseInput(size);
	const formContext = focus.context(context, {
		fieldHasSelection: selection.current,
		formRefusal: focus.current()?.id === "send" ? refusal : undefined,
	});
	useControlDispatch({
		mode: focus.mode,
		context: formContext,
		active: focused && inputActive,
		onUnavailable,
		onEmergencyExit,
		handlers: {
			"move-field": ({ key }) => {
				moveField(key.name, key.shift === true);
				key.preventDefault?.();
			},
			"confirm-choice": ({ key }) => {
				key.preventDefault?.();
				const slot = focus.current();
				if (slot?.id === "send") {
					if (refusal === undefined) onSend(text.current);
					return;
				}
				if (slot?.id === "discard") onDiscard();
			},
			"copy-selection": ({ key }) => {
				const result = field.current?.copySelection();
				onUnavailable?.(result?.reason ?? "The response editor holds no field to copy from");
				key.preventDefault?.();
			},
			"close-form": ({ key }) => {
				key.preventDefault?.();
				onClose(field.current?.value() ?? text.current);
			},
			help: () => onHelp?.(),
			message: () => onMessage?.(),
		},
	});
	const ink = controlInk();
	// The box owns two border cells and one padding cell per side, so the rows
	// inside it are what the fields and actions may take.
	const contentWidth = Math.max(1, width - 6);
	const draftHeight = Math.max(MINIMUM_DRAFT_ROWS, rows - FIXED_ROWS);
	return createElement(
		"box",
		{
			border: true,
			borderColor: ink.indicator.fg ?? COLORS.borderFocused,
			title: "Response",
			padding: 1,
			style: { flexDirection: "column", height: Math.max(RESPONSE_EDITOR_ROWS, rows) },
		},
		createElement(DraftField, {
			label: "Response draft",
			value: draft,
			focused: focused && inputActive && focus.at === 0,
			inputActive: focused && inputActive,
			width: Math.max(1, contentWidth - MARKER_WIDTH),
			height: draftHeight,
			fieldRef: field,
			error: null,
			hint: "Closing keeps the draft saved; Discard deletes it",
			oversize: (value: string) =>
				validateResponseInput(value)?.includes("UTF-8 bytes") ? valueReason(value) : null,
			onValueChange: (facts) => {
				text.current = facts.value;
				selection.current = facts.selection !== "";
				setSize(facts.value);
			},
			onRefuse: (reason: string) => onUnavailable?.(reason),
		}),
		createElement(ActionItem, {
			row: { key: "send", label: "Send response" } satisfies ActionRow,
			focused: focused && inputActive && focus.at === 1,
			width: contentWidth,
			refusal: focus.at === 1 ? (refusal ?? null) : null,
		}),
		createElement(ActionItem, {
			row: { key: "discard", label: "Discard draft" } satisfies ActionRow,
			focused: focused && inputActive && focus.at === 2,
			width: contentWidth,
		}),
		createElement(
			"text",
			{ fg: ink.detail.fg ?? undefined },
			truncateToWidth("Tab moves between the field and the actions", contentWidth),
		),
	);
}

/** The size reason alone, because an empty reply is the Send action's news. */
function valueReason(value: string): string | null {
	return validateResponseInput(value) ?? null;
}
