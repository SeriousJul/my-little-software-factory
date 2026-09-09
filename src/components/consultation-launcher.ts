/**
 * The Consultation launcher: a shared-control form, and nothing else.
 *
 * The launcher collects a Consultation type, a Repository, and the operator's
 * initial input, and it opens a Consultation only when the operator runs the
 * visible Launch action. Every control on the screen comes from the shared
 * control library: two selectors, one Draft field, and two actions, so the keys
 * an operator learns here are the keys the override panel and the response
 * editor answer with.
 *
 * Closing and discarding are two different actions. Escape closes the launcher
 * and hands the unfinished form back to the screen that owns it, which keeps it
 * for the rest of this application run; the launcher states that in those words.
 * `Discard` is a visible action that deletes the text on purpose. A closed form
 * never comes back on a different Repository or a different Consultation type,
 * because that would send the operator's words somewhere they were not
 * addressed.
 *
 * The keys: Tab and Shift+Tab move between the five slots. Up and Down move a
 * selector's value or the form's focus, and inside the Draft field they move the
 * caret. Left and Right cycle a selector and move the caret in the field. Enter
 * adds a line inside the Draft field and runs the action it stands on. F1 opens
 * the Key guide and F2 the Message view, and both leave the draft, the caret,
 * the selection, and the undo history as they were. Escape closes with the text
 * kept.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";

import type { ConsultationTypeConfig } from "../config.ts";
import {
	CONSULTATION_INPUT_LIMIT,
	type ConsultationRepositoryOption,
	utf8ByteLength,
	validateConsultationInput,
} from "../consultation.ts";
import { useControlDispatch } from "./control-dispatch.ts";
import type { ControlContext, InteractionMode } from "./controls.ts";
import { contextFor } from "./controls.ts";
import type { MessageFact } from "./messages.ts";
import { type ActionRow, MARKER_WIDTH, ModalSurface, modalFrame } from "./modal-chrome.ts";
import { ActionItem, ChoiceRow } from "./shared/choices.ts";
import { DraftField, type FieldHandle } from "./shared/fields.ts";
import { type FormFocus, moveFieldWith, useFormSlots } from "./shared/form.ts";
import { controlInk, STATE_WORDS } from "./shared/presentation.ts";
import { truncateToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

/** The whole unfinished form, kept by the screen that owns the launcher. */
export interface LauncherDraft {
	typeName: string;
	repositoryIdentity: string;
	input: string;
}

interface ConsultationLauncherProps {
	types: Readonly<Record<string, ConsultationTypeConfig>>;
	repositories: readonly ConsultationRepositoryOption[];
	/** The form the operator left when the launcher last closed, if any. */
	draft?: LauncherDraft | null;
	title?: string;
	onLaunch: (typeName: string, repository: ConsultationRepositoryOption, input: string) => void;
	/** Close the launcher and keep the unfinished form for this application run. */
	onClose: (kept: LauncherDraft) => void;
	/** Delete the unfinished form. Closing never does this on its own. */
	onDiscard: () => void;
	/** The base control facts, preserved while this surface owns input. */
	context: ControlContext;
	/** False while a Key guide or Message view is above this launcher. */
	inputActive?: boolean;
	/** Open the Key guide on the mode this launcher is running. */
	onHelp?: (mode: InteractionMode) => void;
	onMessage?: (mode: InteractionMode) => void;
	/** Reports the catalogue reason for a refused control on the Message line. */
	onUnavailable?: (reason: string) => void;
	/** The Message fact this surface's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
}

/** The launcher's slots, in the order Tab walks them. */
const SLOTS = [
	{ id: "type", kind: "selector", label: "Type" },
	{ id: "repository", kind: "selector", label: "Repository" },
	{ id: "input", kind: "field", label: "Initial input" },
	{ id: "launch", kind: "action", label: "Launch Consultation" },
	{ id: "discard", kind: "action", label: "Discard draft text" },
] as const;

/** What the launcher states about its own temporary retention. */
const RETENTION_NOTE = `Closing keeps this form for this run only: it is ${STATE_WORDS.notSaved}`;

/**
 * The rows a launcher draws around its Draft field: two selectors, the field's
 * own label and hint lines, two actions, and the retention note.
 *
 * The count is what keeps the box honest: a surface is handed no more rows than
 * it holds, so a row left out of this total would paint through the row below
 * it. The two written reasons a launcher can add - the field's size line and an
 * action's refusal - are counted where they are produced.
 */
const FIXED_ROWS = 7;
/** The rows the Draft field wants, and the fewest it may be drawn with. */
const PREFERRED_DRAFT_ROWS = 3;
const MINIMUM_DRAFT_ROWS = 2;

/** The columns the launcher lays its rows out in, at one content width. */
function launcherColumns(contentWidth: number): { labelWidth: number; valueWidth: number } {
	const labelWidth = Math.min(13, Math.max(1, contentWidth - 12));
	return { labelWidth, valueWidth: Math.max(1, contentWidth - labelWidth - MARKER_WIDTH) };
}

export function ConsultationLauncher({
	types,
	repositories,
	draft,
	title = "Consultation launcher",
	onLaunch,
	onClose,
	onDiscard,
	context,
	inputActive = true,
	onHelp,
	onMessage,
	onUnavailable,
	message,
	onEmergencyExit,
}: ConsultationLauncherProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const names = Object.keys(types);
	const [indexes, setIndexes] = useState(() => ({
		type: Math.max(0, names.indexOf(draft?.typeName ?? "")),
		repository: Math.max(
			0,
			repositories.findIndex((item) => item.identity === draft?.repositoryIdentity),
		),
	}));
	// The refs mirror what the key handlers read: the parser can deliver two
	// keys in one tick, and the second must act on the slot the first landed on.
	const typeRef = useRef(indexes.type);
	const repositoryRef = useRef(indexes.repository);
	const inputRef = useRef(draft?.input ?? "");
	const selectionRef = useRef(false);
	const field = useRef<FieldHandle | null>(null);
	const focus: FormFocus = useFormSlots(SLOTS);
	const [draftSize, setDraftSize] = useState(inputRef.current);

	const currentType = () => names[typeRef.current];
	const currentRepository = () => repositories[repositoryRef.current];
	/** The whole form as it stands, for closing and for launching. */
	const formOf = (): LauncherDraft => ({
		typeName: currentType() ?? "",
		repositoryIdentity: currentRepository()?.identity ?? "",
		input: field.current?.value() ?? inputRef.current,
	});
	const cycle = (delta: number) => {
		const slot = focus.current();
		if (slot?.id === "type" && names.length > 0) {
			typeRef.current = (typeRef.current + delta + names.length) % names.length;
		} else if (slot?.id === "repository" && repositories.length > 0) {
			repositoryRef.current =
				(repositoryRef.current + delta + repositories.length) % repositories.length;
		} else {
			return;
		}
		setIndexes({ type: typeRef.current, repository: repositoryRef.current });
	};
	// The launcher's own domain rule decides what it can send: the count and
	// emptiness rules belong to the Consultation, not to a field.
	const refusal = (): string | undefined => {
		if (names.length === 0) {
			return "no Consultation types configured; add [consultation-types.<name>] to the config file";
		}
		if (repositories.length === 0) return "no verified Repository is available";
		return validateConsultationInput(formOf().input);
	};
	const launch = () => {
		if (refusal() !== undefined) return;
		const typeName = currentType();
		const repository = currentRepository();
		if (typeName === undefined || repository === undefined) return;
		onLaunch(typeName, repository, formOf().input);
	};

	const moveField = moveFieldWith(focus);
	const formContext = focus.context(context, {
		fieldHasSelection: selectionRef.current,
		formCycleCount: focus.current()?.id === "type" ? names.length : repositories.length,
		formRefusal: focus.current()?.id === "launch" ? refusal() : undefined,
	});
	useControlDispatch({
		mode: focus.mode,
		context: formContext,
		active: inputActive,
		onUnavailable,
		onEmergencyExit,
		// The arrows inside a Draft field belong to its caret, so only the
		// selector and action slots let the form move.
		handlers: {
			"move-field": ({ key }) => moveField(key.name, key.shift === true),
			"cycle-choice": ({ key }) => cycle(key.name === "left" ? -1 : 1),
			"confirm-choice": () => {
				const slot = focus.current();
				if (slot?.id === "launch") launch();
				else if (slot?.id === "discard") onDiscard();
			},
			"copy-selection": () => {
				const result = field.current?.copySelection();
				onUnavailable?.(result?.reason ?? "The launcher holds no field to copy from");
			},
			"close-form": () => onClose(formOf()),
			help: () => onHelp?.(formContext.mode),
			message: () => onMessage?.(formContext.mode),
		},
	});

	const ink = controlInk();
	const bytes = utf8ByteLength(draftSize);
	// The rows are counted before the box is sized, because a surface is handed
	// no more rows than it holds: a written reason that pushed the box past its
	// own height would paint through the border instead of explaining anything.
	const draftError =
		utf8ByteLength(draftSize) > CONSULTATION_INPUT_LIMIT
			? validateConsultationInput(draftSize)
			: undefined;
	const actionError = focus.at === 3 && inputActive ? refusal() : undefined;
	const noteRows = (draftError === undefined ? 0 : 1) + (actionError === undefined ? 0 : 1);
	const frame = modalFrame(terminalWidth, terminalHeight, {
		rows: FIXED_ROWS + PREFERRED_DRAFT_ROWS + noteRows,
		minRows: FIXED_ROWS + MINIMUM_DRAFT_ROWS,
		margin: 0,
	});
	const columns = launcherColumns(frame.contentWidth);
	const draftHeight = Math.max(MINIMUM_DRAFT_ROWS, frame.contentRows - FIXED_ROWS - noteRows);
	const rows: ReactElement[] = [
		createElement(ChoiceRow, {
			key: "type",
			label: "Type",
			value: names[indexes.type] ?? "",
			focused: focus.at === 0 && inputActive,
			width: columns.valueWidth,
			labelWidth: columns.labelWidth,
			placeholder: "(none)",
		}),
		createElement(ChoiceRow, {
			key: "repository",
			label: "Repository",
			value: repositories[indexes.repository]?.displayName ?? "",
			focused: focus.at === 1 && inputActive,
			width: columns.valueWidth,
			labelWidth: columns.labelWidth,
			placeholder: STATE_WORDS.unavailable,
		}),
		createElement(DraftField, {
			key: "input",
			label: "Initial input",
			value: draft?.input ?? "",
			focused: focus.at === 2 && inputActive,
			inputActive,
			width: columns.valueWidth,
			labelWidth: columns.labelWidth,
			height: draftHeight,
			fieldRef: field,
			hint: `UTF-8 bytes: ${bytes}/${CONSULTATION_INPUT_LIMIT}`,
			// The size reason belongs on the field, because the field is where the
			// oversized text is: the text stays editable so the operator can shorten
			// it. An empty draft is the Launch action's news, not the field's.
			oversize: () => draftError ?? null,
			onValueChange: (facts) => {
				inputRef.current = facts.value;
				selectionRef.current = facts.selection !== "";
				setDraftSize(facts.value);
			},
			onRefuse: (reason: string) => onUnavailable?.(reason),
		}),
		createElement(
			"box",
			{ key: "actions", style: { flexDirection: "column" } },
			createElement(ActionItem, {
				row: { key: "launch", label: "Launch Consultation" } satisfies ActionRow,
				focused: focus.at === 3 && inputActive,
				width: frame.contentWidth,
				refusal: actionError ?? null,
			}),
			createElement(ActionItem, {
				row: { key: "discard", label: "Discard draft text" } satisfies ActionRow,
				focused: focus.at === 4 && inputActive,
				width: frame.contentWidth,
			}),
		),
	];

	return createElement(ModalSurface, {
		frame,
		width: terminalWidth,
		title,
		borderColor: ink.indicator.fg ?? COLORS.borderFocused,
		minContentRows: FIXED_ROWS + MINIMUM_DRAFT_ROWS,
		message,
		bar: { mode: formContext.mode, context: contextFor(formContext.mode, formContext) },
		children: [
			...rows,
			createElement(
				"text",
				{ key: "note", fg: ink.detail.fg ?? undefined },
				truncateToWidth(RETENTION_NOTE, frame.contentWidth),
			),
		],
	});
}
