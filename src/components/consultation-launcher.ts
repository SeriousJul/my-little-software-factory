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
import type { ConsultationRepositoryOption } from "../consultation/checkout-safety.ts";
import {
	CONSULTATION_INPUT_LIMIT,
	validateConsultationInput,
} from "../consultation/response-draft.ts";
import { utf8ByteLength } from "../text-bounds.ts";
import { type ControlHandler, useControlDispatch } from "./control-dispatch.ts";
import type { InteractionMode, StandingFacts } from "./controls.ts";

import type { MessageFact } from "./messages.ts";
import { type ActionRow, MARKER_WIDTH, ModalSurface, modalFrame } from "./modal-chrome.ts";
import { ActionItem, ChoiceRow, useChoice } from "./shared/choices.ts";
import { DraftField, type FieldHandle } from "./shared/fields.ts";
import { copySelectionWith, type FormFocus, moveFieldWith, useFormSlots } from "./shared/form.ts";
import { controlInk, STATE_WORDS } from "./shared/presentation.ts";
import { truncateToWidth } from "./text.ts";

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
	/** The plane's standing facts, read the same way in every mode. */
	standing: StandingFacts;
	/** False while a Key guide or Message view is above this launcher. */
	inputActive?: boolean;
	/** Open the Key guide on the mode this launcher is running. */
	onHelp?: (mode: InteractionMode) => void;
	onMessage?: (mode: InteractionMode) => void;
	/** Reports the catalogue reason for a refused control on the Message line. */
	onUnavailable?: (reason: string) => void;
	/** Report what a control that ran did, on the surface's own news line. */
	onCopy: (news: MessageFact) => void;
	/** The Message fact this surface's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
	/**
	 * The Queue pause's key on this launcher (issue #319, ADR 0111): the brake
	 * reaches every surface the plane draws, the form's selector and action rows
	 * included, on the F4 alias the field modes carry. Required, because a
	 * surface that resolves the key and swallows it would be a key the plane
	 * takes and never answers.
	 */
	onQueuePause: () => void;
	/**
	 * The Auto-handoff mode's key on this launcher (issue #319, ADR 0111), on
	 * the F5 alias: required for the same reason.
	 */
	onAutoHandoff: () => void;
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

export function ConsultationLauncher(props: ConsultationLauncherProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const choices = useLauncherChoices(props.types, props.repositories, props.draft);
	const form = useLauncherForm(props, choices);
	const formFacts = launcherFormFacts(props, form);
	const modeFacts = formFacts();
	const frameFacts = useLauncherFrame({
		draftSize: form.draftSize,
		focus: form.focus,
		inputActive: props.inputActive ?? true,
		refusal: form.refusal,
		terminalWidth,
		terminalHeight,
	});
	useControlDispatch({
		facts: formFacts,
		active: props.inputActive,
		onUnavailable: props.onUnavailable,
		onEmergencyExit: props.onEmergencyExit,
		// The arrows inside a Draft field belong to its caret, so only the
		// selector and action slots let the form move.
		handlers: launcherHandlers(props, { form, mode: modeFacts.mode }),
	});

	const rows = launcherRows(props, form, frameFacts);
	const ink = controlInk();

	return createElement(ModalSurface, {
		frame: frameFacts.frame,
		width: terminalWidth,
		title: props.title ?? "Consultation launcher",
		body: {
			above: [],
			below: [
				...rows,
				createElement(
					"text",
					{ key: "note", fg: ink.detail.fg ?? undefined },
					truncateToWidth(RETENTION_NOTE, frameFacts.frame.contentWidth),
				),
			],
			minRows: FIXED_ROWS + MINIMUM_DRAFT_ROWS,
		},
		message: props.message,
		bar: { mode: modeFacts.mode, facts: modeFacts },
		queuePaused: props.standing.queuePaused,
	});
}

/** The launcher's two choices: the Consultation type, the Repository. */
function useLauncherChoices(
	types: Readonly<Record<string, ConsultationTypeConfig>>,
	repositories: readonly ConsultationRepositoryOption[],
	draft: LauncherDraft | null | undefined,
) {
	const names = Object.keys(types);
	const typeChoice = useChoice(names, draft?.typeName);
	const repositoryChoice = useChoice(
		repositories,
		// Case-insensitive: a record an older plane stored keeps the API's
		// owner casing, and the catalog identity is canonical lowercase.
		repositories.find(
			(item) => item.identity.toLowerCase() === (draft?.repositoryIdentity ?? "").toLowerCase(),
		),
	);
	return { names, typeChoice, repositoryChoice };
}

/** The launcher's form: the slots, the draft's bytes, the send rules. */
function useLauncherForm(
	props: ConsultationLauncherProps,
	choices: ReturnType<typeof useLauncherChoices>,
) {
	const { names, typeChoice, repositoryChoice } = choices;
	const { repositories, draft, onLaunch } = props;
	const inputRef = useRef(draft?.input ?? "");
	const selectionRef = useRef(false);
	const field = useRef<FieldHandle | null>(null);
	const focus: FormFocus = useFormSlots(SLOTS);
	const [draftSize, setDraftSize] = useState(inputRef.current);

	const currentType = () => typeChoice.value();
	const currentRepository = () => repositoryChoice.value();
	/** The whole form as it stands, for closing and for launching. */
	const formOf = (): LauncherDraft => ({
		typeName: currentType() ?? "",
		repositoryIdentity: currentRepository()?.identity ?? "",
		input: field.current?.value() ?? inputRef.current,
	});
	const cycle = (delta: number) => {
		const slot = focus.current();
		if (slot?.id === "type") typeChoice.cycle(delta);
		else if (slot?.id === "repository") repositoryChoice.cycle(delta);
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
	return {
		names,
		repositories,
		draftSize,
		setDraftSize,
		inputRef,
		selectionRef,
		field,
		focus,
		currentType,
		currentRepository,
		formOf,
		cycle,
		refusal,
		launch,
	};
}

/** The form module's slot facts: the cycle count, the refusal. */
function launcherFormFacts(
	props: ConsultationLauncherProps,
	form: ReturnType<typeof useLauncherForm>,
): () => ReturnType<FormFocus["facts"]> {
	return () =>
		form.focus.facts(props.standing, {
			fieldHasSelection: form.selectionRef.current,
			formCycleCount: form.focus.holds("type")
				? form.names.length
				: form.focus.holds("repository")
					? form.repositories.length
					: undefined,
			formRefusal: form.focus.holds("launch") ? form.refusal() : undefined,
		});
}

/** The launcher's control catalogue handlers. */
function launcherHandlers(
	props: ConsultationLauncherProps,
	fields: {
		form: ReturnType<typeof useLauncherForm>;
		mode: ReturnType<FormFocus["facts"]>["mode"];
	},
): Record<string, ControlHandler> {
	const { form, mode } = fields;
	const moveField = moveFieldWith(form.focus);
	return {
		"move-field": ({ key }) => {
			moveField(key.name, key.shift === true);
			key.preventDefault?.();
		},
		"cycle-choice": ({ key }) => {
			form.cycle(key.name === "left" ? -1 : 1);
			key.preventDefault?.();
		},
		"confirm-choice": ({ key }) => {
			const slot = form.focus.current();
			// Enter on the Draft field belongs to the field, and its action only
			// runs from the row that names it.
			key.preventDefault?.();
			if (slot?.id === "launch") form.launch();
			else if (slot?.id === "discard") props.onDiscard();
		},
		"copy-selection": copySelectionWith(() => form.field.current, props.onCopy),
		"close-form": ({ key }) => {
			key.preventDefault?.();
			props.onClose(form.formOf());
		},
		help: () => props.onHelp?.(mode),
		message: () => props.onMessage?.(mode),
		// The plane-level keys reach the form's rows too (issue #319,
		// ADR 0111), on the F4 and F5 aliases the field modes carry: the
		// letters would type into the Draft field, the F-keys do not.
		"queue-pause": props.onQueuePause,
		"auto-handoff": props.onAutoHandoff,
	};
}

/** The launcher's box: the rows the reasons add, the columns, the draft height. */
function useLauncherFrame(fields: {
	draftSize: string;
	focus: FormFocus;
	inputActive: boolean;
	refusal: () => string | undefined;
	terminalWidth: number;
	terminalHeight: number;
}) {
	const { draftSize, focus, inputActive, refusal, terminalWidth, terminalHeight } = fields;
	// The rows are counted before the box is sized, because a surface is handed
	// no more rows than it holds: a written reason that pushed the box past its
	// own height would paint through the border instead of explaining anything.
	const draftError =
		utf8ByteLength(draftSize) > CONSULTATION_INPUT_LIMIT
			? validateConsultationInput(draftSize)
			: undefined;
	const actionError = focus.paints("launch") && inputActive ? refusal() : undefined;
	const noteRows = (draftError === undefined ? 0 : 1) + (actionError === undefined ? 0 : 1);
	const frame = modalFrame(terminalWidth, terminalHeight, {
		rows: FIXED_ROWS + PREFERRED_DRAFT_ROWS + noteRows,
		minRows: FIXED_ROWS + MINIMUM_DRAFT_ROWS,
		margin: 0,
	});
	const columns = launcherColumns(frame.contentWidth);
	const draftHeight = Math.max(MINIMUM_DRAFT_ROWS, frame.contentRows - FIXED_ROWS - noteRows);
	return { frame, columns, draftHeight, draftError, actionError };
}

/** The launcher's rows: the choices, the draft, the actions. */
function launcherRows(
	props: ConsultationLauncherProps,
	form: ReturnType<typeof useLauncherForm>,
	frameFacts: ReturnType<typeof useLauncherFrame>,
): ReactElement[] {
	const { frame, columns, draftHeight, draftError, actionError } = frameFacts;
	const inputActive = props.inputActive ?? true;
	return [
		...launcherChoiceRows(form, columns, inputActive),
		launcherDraftRow({ props, form, columns, draftHeight, draftError, inputActive }),
		launcherActionRows(form, frame, actionError, inputActive),
	];
}

/** The two selector rows: the Consultation type, the Repository. */
function launcherChoiceRows(
	form: ReturnType<typeof useLauncherForm>,
	columns: ReturnType<typeof launcherColumns>,
	inputActive: boolean,
): ReactElement[] {
	return [
		createElement(ChoiceRow, {
			key: "type",
			label: "Type",
			value: form.currentType() ?? "",
			focused: form.focus.paints("type") && inputActive,
			width: columns.valueWidth,
			labelWidth: columns.labelWidth,
			placeholder: "(none)",
		}),
		createElement(ChoiceRow, {
			key: "repository",
			label: "Repository",
			value: form.currentRepository()?.displayName ?? "",
			focused: form.focus.paints("repository") && inputActive,
			width: columns.valueWidth,
			labelWidth: columns.labelWidth,
			placeholder: STATE_WORDS.unavailable,
		}),
	];
}

/** The Draft field row, with its size reason and its selection. */
function launcherDraftRow(fields: {
	props: ConsultationLauncherProps;
	form: ReturnType<typeof useLauncherForm>;
	columns: ReturnType<typeof launcherColumns>;
	draftHeight: number;
	draftError: string | undefined;
	inputActive: boolean;
}): ReactElement {
	const { props, form, columns, draftHeight, draftError, inputActive } = fields;
	const bytes = utf8ByteLength(form.draftSize);
	return createElement(DraftField, {
		key: "input",
		label: "Initial input",
		value: props.draft?.input ?? "",
		focused: form.focus.paints("input") && inputActive,
		inputActive,
		width: columns.valueWidth,
		labelWidth: columns.labelWidth,
		height: draftHeight,
		fieldRef: form.field,
		hint: `UTF-8 bytes: ${bytes}/${CONSULTATION_INPUT_LIMIT}`,
		// The size reason belongs on the field, because the field is where the
		// oversized text is: the text stays editable so the operator can shorten
		// it. An empty draft is the Launch action's news, not the field's.
		oversize: () => draftError ?? null,
		onValueChange: (facts) => {
			form.inputRef.current = facts.value;
			form.selectionRef.current = facts.selection !== "";
			form.setDraftSize(facts.value);
		},
		onRefuse: (reason: string) => props.onUnavailable?.(reason),
	});
}

/** The two action rows: the launch, the discard. */
function launcherActionRows(
	form: ReturnType<typeof useLauncherForm>,
	frame: ReturnType<typeof modalFrame>,
	actionError: string | undefined,
	inputActive: boolean,
): ReactElement {
	return createElement(
		"box",
		{ key: "actions", style: { flexDirection: "column" } },
		createElement(ActionItem, {
			row: { key: "launch", label: "Launch Consultation" } satisfies ActionRow,
			focused: form.focus.paints("launch") && inputActive,
			width: frame.contentWidth,
			refusal: actionError ?? null,
		}),
		createElement(ActionItem, {
			row: { key: "discard", label: "Discard draft text" } satisfies ActionRow,
			focused: form.focus.paints("discard") && inputActive,
			width: frame.contentWidth,
		}),
	);
}
