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
import { currentThemeResolution } from "../../theme-source.ts";
import { useControlDispatch } from "../control-dispatch.ts";
import { contextFor } from "../controls.ts";
import { type MessageFact, messageRowElement } from "../messages.ts";
import { type ActionRow, MARKER_WIDTH, ModalSurface, modalFrame } from "../modal-chrome.ts";
import { truncateToWidth } from "../text.ts";
import { paint } from "../theme.ts";
import { KeyGuide } from "../utility.ts";
import { ActionItem, ChoiceRow } from "./choices.ts";
import { DraftField, type FieldFacts, type FieldHandle, TextField } from "./fields.ts";
import { copySelectionWith } from "./form.ts";
import { controlInk, NO_COLOR_INK, STATE_WORDS } from "./presentation.ts";
import { HERDR_THEME_VERSION, THEME_ROLES, type ThemeRole, unknownThemeWarning } from "./theme.ts";
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
	render: (
		columns: GalleryColumns,
		holds: string,
		inputActive: boolean,
		wiring: GalleryFieldWiring,
	) => ReactElement[];
	/** Whether this example is drawn at a narrow terminal. */
	narrow?: boolean;
}

/**
 * What the gallery hands a field example.
 *
 * One example shows one focused control, as a form holds: the focused field
 * gets the gallery's handle, so Copy selection reaches it, and its fact
 * reports keep the Action bar's Copy control honest.
 */
export interface GalleryFieldWiring {
	/** The gallery's field handle: the focused field's selection and copy. */
	fieldRef: { current: FieldHandle | null };
	/** Every fact report from the focused field: the bar tracks its selection. */
	report: (facts: FieldFacts) => void;
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
	notes: "reason",
	priority: "rank",
	narrow: "draft",
	"no-color": "no-color-repository",
};

/** One role's swatch: the role's color under the role's name. */
function themeSwatchRow(theme: { roles: Record<ThemeRole, string> }): ReactElement {
	return createElement(
		"text",
		{ key: "swatches" },
		...THEME_ROLES.map((role) =>
			createElement(
				"span",
				{
					key: role,
					// A role the theme resolves to `reset` paints the terminal's
					// own default: the name stands without a swatch.
					bg: theme.roles[role] === "reset" ? undefined : theme.roles[role],
				},
				` ${role}  `,
			),
		),
	);
}

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
		render: (columns, holds, inputActive, wiring) => [
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
				...(holds === "context" ? { fieldRef: wiring.fieldRef, onValueChange: wiring.report } : {}),
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
				...(holds === "draft" ? { fieldRef: wiring.fieldRef, onValueChange: wiring.report } : {}),
			}),
		],
	},
	{
		id: "states",
		state: "invalid, unavailable, and loading",
		render: (columns, holds, _inputActive, _wiring) => [
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
		render: (columns, holds, inputActive, wiring) => [
			createElement(GalleryTypeAhead, {
				key: "type-ahead",
				initial: "openai/gpt-5.1",
				focused: holds === "type-ahead",
				inputActive,
				fieldRef: wiring.fieldRef,
				onFieldFacts: wiring.report,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
			}),
		],
	},
	{
		id: "notes",
		state: "a written reason wider than its column, and a waiting row",
		render: (columns, holds, _inputActive, _wiring) => {
			// The panel's own geometry: a value column narrower than the box,
			// and a written reason the surface cuts at its own width, so a
			// sentence wider than the column stays whole at the width the
			// panel names.
			const valueWidth = Math.min(columns.valueWidth, 30);
			return [
				createElement(ChoiceRow, {
					key: "reason",
					label: "Model",
					value: "openai/gpt-5.1-codex",
					focused: holds === "reason",
					width: valueWidth,
					labelWidth: columns.labelWidth,
					warning: true,
					error:
						`agent "codex" (cli) has no model "openai/gpt-5.1-codex": ` +
						`check the model id and its provider auth`,
					noteWidth: columns.contentWidth,
				}),
				createElement(ChoiceRow, {
					key: "waiting",
					label: "Model",
					value: "anthropic/claude-sonnet-4-5",
					focused: holds === "waiting",
					width: valueWidth,
					labelWidth: columns.labelWidth,
					muted: true,
				}),
			];
		},
	},
	{
		id: "priority",
		state:
			"the ticket priority: the rank badge, the selector in each state, and the Consultation reason",
		render: (columns, holds, _inputActive, _wiring) => {
			const ink = controlInk();
			// One ticket row per state of the rank badge: the one-cell digit, 1
			// highest, and an unranked ticket that shows no digit at all.
			const badge = (key: string, digit: string | null, title: string) =>
				createElement(
					"box",
					{ key, style: { flexDirection: "row", height: 1 } },
					createElement(
						"text",
						{ fg: digit === null ? undefined : (ink.detail.fg ?? undefined) },
						digit === null ? "   " : `${digit}  `.slice(0, 4),
					),
					createElement("text", { fg: ink.text.fg ?? undefined }, title),
				);
			return [
				badge("rank-1", "1", "critical fix"),
				badge("rank-3", "3", "routine backlog"),
				badge("rank-none", null, "unranked ticket shows no digit"),
				// The detail pane's selector on the standard choice row: a rank,
				// off, and default (clears the override back to the source). The
				// keys step the row to the next value, and the step writes what
				// it shows, so one press stores a rank, off, or the clear.
				createElement(ChoiceRow, {
					key: "rank",
					label: "Override",
					value: "critical",
					focused: holds === "rank",
					width: columns.valueWidth,
					labelWidth: columns.labelWidth,
					hint: "→/l steps the value and writes it: a rank, off, or default",
				}),
				createElement(ChoiceRow, {
					key: "off",
					label: "Override",
					value: "off",
					focused: holds === "off",
					width: columns.valueWidth,
					labelWidth: columns.labelWidth,
				}),
				createElement(ChoiceRow, {
					key: "default",
					label: "Override",
					value: "",
					focused: holds === "default",
					width: columns.valueWidth,
					labelWidth: columns.labelWidth,
					placeholder: "default",
				}),
				// A Consultation selected: the bump is unavailable with its reason.
				createElement(ChoiceRow, {
					key: "consultation",
					label: "Override",
					value: "",
					focused: holds === "consultation",
					width: columns.valueWidth,
					labelWidth: columns.labelWidth,
					placeholder: STATE_WORDS.unavailable,
					error: "a Consultation has no priority: the bump applies to tickets only",
				}),
				// The bump messages the Message line carries, top and floor no-ops
				// included, so a reviewer reads the whole outcome set.
				createElement(
					"text",
					{
						key: "bump-moved",
						style: { width: "100%", height: 1 },
						fg: ink.detail.fg ?? undefined,
					},
					truncateToWidth(
						"bump: + raised to high   - lowered to routine   from the lowest: set to off",
						columns.contentWidth,
					),
				),
				createElement(
					"text",
					{ key: "bump-noop", style: { width: "100%", height: 1 }, fg: ink.detail.fg ?? undefined },
					truncateToWidth(
						"no-op: already at the highest priority   already unranked",
						columns.contentWidth,
					),
				),
			];
		},
	},
	{
		id: "theme",
		state: "the inherited theme",
		render: (columns, _holds, _inputActive, _wiring) => {
			const resolution = currentThemeResolution();
			return [
				createElement(
					"text",
					{ key: "theme-name", fg: paint("text") },
					truncateToWidth(
						`theme: ${resolution.theme.name} (${resolution.theme.appearance})  ` +
							`built-in definitions vendored from herdr ${HERDR_THEME_VERSION}`,
						columns.contentWidth,
					),
				),
				themeSwatchRow(resolution.theme),
				createElement(
					"text",
					{ key: "theme-note", fg: paint("subtext0") },
					truncateToWidth(
						"a role that resolves to `reset` shows no swatch: the terminal's default stands",
						columns.contentWidth,
					),
				),
			];
		},
	},
	{
		id: "theme-fallback",
		state: "the fallback warning on the Message line",
		render: (columns, _holds, _inputActive, _wiring) => [
			createElement(
				"text",
				{ key: "fallback-note", fg: paint("subtext0") },
				truncateToWidth(
					"inside herdr, a theme the config cannot name falls back and says so once:",
					columns.contentWidth,
				),
			),
			messageRowElement(
				{ severity: "warning", text: unknownThemeWarning("frobnicate") },
				columns.contentWidth,
			),
		],
	},
	{
		id: "no-color",
		state: "the no-color presentation: the same controls, painted with no color",
		render: (columns, holds, inputActive, wiring) => [
			createElement(TextField, {
				key: "no-color-model",
				label: "Model",
				value: "openai/gpt-5.1",
				focused: holds === "no-color-model",
				inputActive,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				ink: NO_COLOR_INK,
				...(holds === "no-color-model"
					? { fieldRef: wiring.fieldRef, onValueChange: wiring.report }
					: {}),
			}),
			createElement(ChoiceRow, {
				key: "no-color-repository",
				label: "Repository",
				value: "my-little-software-factory",
				focused: holds === "no-color-repository",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				ink: NO_COLOR_INK,
			}),
			createElement(
				"box",
				{ key: "no-color-actions", style: { flexDirection: "column" } },
				createElement(ActionItem, {
					row: { key: "no-color-launch", label: "Launch Consultation" } satisfies ActionRow,
					focused: holds === "no-color-launch",
					width: columns.contentWidth,
					ink: NO_COLOR_INK,
				}),
			),
		],
	},
	{
		id: "narrow",
		state: "narrow terminal",
		narrow: true,
		render: (columns, holds, _inputActive, wiring) => [
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
				...(holds === "draft" ? { fieldRef: wiring.fieldRef, onValueChange: wiring.report } : {}),
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
	fieldRef?: { current: FieldHandle | null };
	/** The focused field's fact reports, for the Action bar's Copy control. */
	onFieldFacts?: (facts: FieldFacts) => void;
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
		fieldRef: props.fieldRef,
		width: props.width,
		labelWidth: props.labelWidth,
		placeholder: STATE_WORDS.unset,
		onQueryChange: (_query, match, facts) => {
			if (match.first !== undefined) setValue(match.first);
			props.onFieldFacts?.(facts);
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
	// The focused field's selection, tracked from its own fact reports: the
	// bar's Copy control is available only while a selection exists, and a
	// plain arrow that collapses it must take the control off the bar.
	const [hasSelection, setHasSelection] = useState(false);
	// The outcome of the last Copy selection the operator ran.
	const [message, setMessage] = useState<MessageFact | null>(null);
	const wiring: GalleryFieldWiring = {
		fieldRef: field,
		report: (facts: FieldFacts) => setHasSelection(facts.selection !== ""),
	};
	const ink = controlInk();
	// The Key guide, the shared overlay the Application's F1 opens. While it
	// is open, it owns the keys: the gallery's own dispatch stands down, and
	// the example's fields stay mounted, so closing returns the same field,
	// caret, and selection the operator left.
	const [guideOpen, setGuideOpen] = useState(false);
	const barContext = contextFor("form-field", {
		listCanMove: false,
		detailCanScroll: false,
		sourceCount: 0,
		refreshingSourceCount: 0,
		handoffActive: false,
		messageTruncated: false,
		consultationTypesConfigured: true,
		fieldHasSelection: hasSelection,
	});
	// The gallery's own keys come from the same catalogue the application runs,
	// so a contributor exercises the real dispatch and the real Action bar.
	useControlDispatch({
		mode: "form-field",
		context: barContext,
		onEmergencyExit,
		active: guideOpen === false,
		handlers: {
			help: () => setGuideOpen(true),
			// The gallery is the surface here, so closing its form leaves it the
			// way the application leaves a terminal.
			"close-form": () => onEmergencyExit(),
			"move-field": ({ key }) => {
				const next = (indexRef.current + (key.shift === true ? -1 : 1) + ids.length) % ids.length;
				indexRef.current = next;
				setIndex(next);
				setHasSelection(false);
				setMessage(null);
				key.preventDefault?.();
			},
			// The same shared handler the application's forms run: the gallery's own
			// line is the news line it reports to.
			"copy-selection": copySelectionWith(
				() => field.current,
				(news) => setMessage(news),
			),
		},
	});
	const shown = GALLERY_EXAMPLES[index] ?? GALLERY_EXAMPLES[0];
	const narrow = shown.narrow === true;
	const frame = modalFrame(narrow ? 28 : width, height, { rows: 12, margin: 1 });
	const columns = galleryColumns(frame.contentWidth);
	return createElement(
		"box",
		{ style: { width: "100%", height: "100%" } },
		createElement(ModalSurface, {
			frame,
			width: narrow ? 28 : width,
			title: `Shared controls - ${shown.state}`,
			borderColor: ink.indicator.fg ?? paint("accent"),
			minContentRows: 3,
			message,
			bar: { mode: "form-field", context: barContext },
			children: [
				createElement(
					"text",
					{ key: "state", fg: ink.detail.fg ?? undefined },
					truncateToWidth(
						`state: ${shown.state}  (Tab shows the next example; ${ids.length} in all)`,
						frame.contentWidth,
					),
				),
				...shown.render(columns, FOCUSED_CONTROL[shown.id] ?? shown.id, inputActive, wiring),
			],
		}),
		guideOpen &&
			createElement(KeyGuide, {
				message,
				context: barContext,
				onClose: () => setGuideOpen(false),
				onEmergencyExit,
			}),
	);
}
