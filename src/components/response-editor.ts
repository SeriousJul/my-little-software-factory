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
import { useRef } from "react";

import { responseOversize, validateResponseInput } from "../consultation/response-draft.ts";
import { useControlDispatch } from "./control-dispatch.ts";
import type { StandingFacts } from "./controls.ts";
import { type MessageFact, messageRowElement } from "./messages.ts";
import { type ActionRow, MARKER_WIDTH } from "./modal-chrome.ts";
import { ActionItem } from "./shared/choices.ts";
import { DraftField, type FieldHandle } from "./shared/fields.ts";
import { copySelectionWith, type FormFocus, moveFieldWith, useFormSlots } from "./shared/form.ts";
import { controlInk } from "./shared/presentation.ts";
import { truncateToWidth } from "./text.ts";
import { paint } from "./theme.ts";

interface ResponseEditorProps {
	/** The Response draft the Consultation holds, as the plane saved it. */
	draft: string;
	/** The columns the consultations view gives this panel. */
	width: number;
	/** The rows the consultations view gives this panel, border included. */
	rows: number;
	focused: boolean;
	/** The plane's standing facts, read the same way in every mode. */
	standing: StandingFacts;
	/** False while a Key guide or Message view is above this editor. */
	inputActive?: boolean;
	/** Send the draft to the Consultation's Agent. */
	onSend: (text: string) => void;
	/** Delete the saved Response draft. Closing never does this on its own. */
	onDiscard: () => void;
	/** Store the draft as it stands, on every change and again on close. */
	onDraftChange: (text: string) => void;
	/** Close the editor. The draft it leaves is the one already stored. */
	onClose: () => void;
	onHelp?: () => void;
	onMessage?: () => void;
	onUnavailable?: (reason: string) => void;
	/** Report what a control that ran did, on the surface's own news line. */
	onCopy: (news: MessageFact) => void;
	message: MessageFact | null;
	onEmergencyExit: () => void;
	/**
	 * The Queue pause's key on this editor (issue #319, ADR 0111): the field
	 * mode carries the toggle on the F4 alias, the way it carries Help on F1.
	 * Required, because a surface that resolves the key and swallows it would
	 * be a key the plane takes and never answers.
	 */
	onQueuePause: () => void;
	/**
	 * The Auto-handoff mode's key on this editor (issue #319, ADR 0111), on the
	 * F5 alias: required for the same reason.
	 */
	onAutoHandoff: () => void;
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
const FIXED_ROWS = 11;
/** The fewest rows a Draft field is still a Draft field with. */
const MINIMUM_DRAFT_ROWS = 1;

/** The rows the response editor needs to draw itself at all. */
export const RESPONSE_EDITOR_ROWS = FIXED_ROWS + 1;

export function ResponseEditor({
	draft,
	width,
	rows,
	focused,
	standing,
	inputActive = true,
	onSend,
	onDiscard,
	onDraftChange,
	onClose,
	onHelp,
	onMessage,
	onUnavailable,
	onCopy,
	message,
	onEmergencyExit,
	onQueuePause,
	onAutoHandoff,
}: ResponseEditorProps): ReactElement {
	const field = useRef<FieldHandle | null>(null);
	const text = useRef(draft);
	const selection = useRef(false);
	const focus: FormFocus = useFormSlots(SLOTS);
	const moveField = moveFieldWith(focus);
	/**
	 * The reply as the field holds it at the moment the editor is asked about it.
	 *
	 * The field reports its text through an event that can land after the next key
	 * reaches the form, so the text this render painted can still be the draft the
	 * editor opened on while the operator's own text already sits in the field. The
	 * Send decision reads the field, never the render's copy: a reply the operator
	 * can read on the screen is a reply the editor may send.
	 */
	const liveDraft = (): string => field.current?.value() ?? text.current;
	/** The editor's own domain rule, read against the text it would actually send. */
	const refusal = (): string | undefined => validateResponseInput(liveDraft());
	// The form module states the slot facts: which slot holds the focus, and
	// the selection and the refusal this editor owns. The record names the mode
	// the focused slot owns, so a key that moves the focus moves the mode with
	// it in the same tick.
	const formFacts = () =>
		focus.facts(standing, {
			fieldHasSelection: selection.current,
			formRefusal: focus.holds("send") ? refusal() : undefined,
		});
	useControlDispatch({
		facts: formFacts,
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
					const value = liveDraft();
					if (validateResponseInput(value) === undefined) onSend(value);
					return;
				}
				if (slot?.id === "discard") onDiscard();
			},
			"copy-selection": copySelectionWith(() => field.current, onCopy),
			"close-form": ({ key }) => {
				key.preventDefault?.();
				// The screen keeps the draft, so closing needs no text of its own:
				// the field's current value is already mirrored into the size fact
				// the screen holds.
				onClose();
			},
			help: () => onHelp?.(),
			message: () => onMessage?.(),
			// The plane-level keys reach the field mode on the F4 and F5 aliases
			// (issue #319, ADR 0111): the letters would type into the draft, the
			// F-keys do not.
			"queue-pause": onQueuePause,
			"auto-handoff": onAutoHandoff,
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
			borderColor: ink.indicator.fg ?? paint("accent"),
			title: "Response",
			padding: 1,
			style: { flexDirection: "column", height: Math.max(RESPONSE_EDITOR_ROWS, rows) },
		},
		createElement(DraftField, {
			label: "Response draft",
			value: draft,
			focused: focused && inputActive && focus.paints("draft"),
			inputActive: focused && inputActive,
			width: Math.max(1, contentWidth - MARKER_WIDTH),
			height: draftHeight,
			fieldRef: field,
			error: null,
			hint: "Closing keeps the draft saved; Discard deletes it",
			oversize: (value: string) => responseOversize(value) ?? null,
			onValueChange: (facts) => {
				text.current = facts.value;
				selection.current = facts.selection !== "";
				onDraftChange(facts.value);
			},
			onRefuse: (reason: string) => onUnavailable?.(reason),
		}),
		createElement(ActionItem, {
			row: { key: "send", label: "Send response" } satisfies ActionRow,
			focused: focused && inputActive && focus.paints("send"),
			width: contentWidth,
			refusal: focus.paints("send") ? (refusal() ?? null) : null,
		}),
		createElement(ActionItem, {
			row: { key: "discard", label: "Discard draft" } satisfies ActionRow,
			focused: focused && inputActive && focus.paints("discard"),
			width: contentWidth,
		}),
		createElement(
			"text",
			{ fg: ink.detail.fg ?? undefined },
			truncateToWidth("Tab moves between the field and the actions", contentWidth),
		),
		// The editor owns a Message line like every other surface, so a refusal
		// or a delivery result is read here rather than on a line the operator
		// has to look elsewhere for.
		messageRowElement(message, contentWidth),
	);
}
