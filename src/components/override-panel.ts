/**
 * The override panel: a one-shot change to the settings of a single
 * handoff, made before the handoff starts. It applies to that handoff only
 * and never becomes a new default.
 *
 * It is a centered modal with one row per setting: the agent type, the
 * environment kind, the task type, and the settings the chosen agent type
 * maps. A setting the agent does not map has no row of its own, so the panel
 * shows only what the chosen agent supports. One exception keeps a value in
 * reach: a row carrying a value the agent cannot take stays on screen, in the
 * warning color, while another source resolved that value, because that row
 * is the only place the operator can clear it and the panel never shows
 * something other than what the handoff sends. A value is untakable when the
 * agent maps no setting for it, when it lists thinking levels and the value
 * is not one of them, or when a context row does not hold a token count.
 *
 * The Model row, the free-text Thinking row, and the Context row are standard
 * single-line inputs. They show a caret, and take typing, caret movement with
 * the arrows, Home and End, selection, backspace and delete, undo and redo,
 * and bracketed terminal paste. A paste is sanitized by the input before it is
 * inserted: ANSI escape sequences and line breaks are stripped, so a pasted
 * model name is plain text. The Context row goes one step further and keeps
 * digits only, typed or pasted, because its value is a token count that
 * reaches the agent as one argv element, and it folds a leading zero, so the
 * row shows one spelling of the count it sends. A character that row refuses
 * leaves the caret where the operator left it, so the next keystroke lands
 * where they put it. An input scrolls horizontally within its column and
 * never wraps, so it can never corrupt the rows around it.
 *
 * A list row (agent, environment, task type, and the thinking value when the
 * agent has a value list) cycles its value with left/right and h/l.
 *
 * The guide row under the rows follows the selection, and a row carrying an
 * untakable value names the way out in its guide: the key that clears the
 * row, or the arrows that cycle a list row onto a value its Agent offers.
 *
 * The keys: up/down and tab/shift+tab move the row selection. j and k move
 * it too, except on a selected text row, where they type. left/right move
 * the caret on a text row and cycle a list row's value; h and l type on a
 * text row and cycle a list row's value. The input owns everything else:
 * typing, backspace, delete, Home, End, undo, redo, and paste. The Agent,
 * Model, Thinking, and Context rows start on the selected Task type's
 * resolved profile. Switching task type re-derives each untouched setting, so
 * the panel always shows what the handoff will run on: on a route the operator
 * opened from a workflow row, that re-derive follows the new Task type's own
 * profile and leaves the edge's Agent pin behind. Clearing a text row, or
 * pressing Backspace or Delete on a Thinking list row, leaves that setting to
 * the Agent. Enter confirms and hands off. Esc cancels. While it is open, the
 * keys of the app below are disabled.
 *
 * The panel sizes itself to the terminal: the value column shrinks first,
 * then the label column, then the marker. The hint row drops when the
 * terminal cannot hold it, and the rows scroll within the viewport when the
 * height cannot hold them all: the selected row always stays on screen. A
 * row never wraps or interleaves.
 */
import type { InputRenderable } from "@opentui/core";
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactElement, type RefObject, useRef, useState } from "react";

import { isTokenCount, tokenCountDigits } from "../domain/settings.ts";
import type { EnvironmentKind } from "../domain/ticket.ts";
import type { HandoffChoice } from "../handoff.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { COLORS } from "./theme.ts";

/** Which settings an agent type maps, for hiding rows it does not support. */
export interface AgentSettings {
	model: boolean;
	thinking: boolean;
	/** Whether a maximum context window can reach this agent type. */
	contextWindow: boolean;
	thinkingValues?: readonly string[];
}

interface OverridePanelProps {
	agents: readonly string[];
	environments: readonly EnvironmentKind[];
	taskTypes: readonly string[];
	agentSettings: Readonly<Record<string, AgentSettings>>;
	/** The resolved Task profile start values, keyed by Task type name. */
	taskProfileChoices: Readonly<Record<string, HandoffChoice>>;
	/** The values the panel starts on: the resolved config choice. */
	initial: HandoffChoice;
	onConfirm: (choice: HandoffChoice) => void;
	onCancel: () => void;
}

type ListKey = "agentType" | "environment" | "taskType";
type TextKey = "model" | "thinking" | "contextWindow";

interface PanelRow {
	label: string;
	key: ListKey | TextKey;
	kind: "list" | "text";
	options?: readonly string[];
	/**
	 * Why this row's value cannot reach the selected Agent, and so cannot
	 * survive a handoff. Undefined means the Agent takes the value as it is.
	 */
	unfit?: UnfitSetting;
	/** True when the row is a text field that takes digits and nothing else. */
	digits?: boolean;
}

/** The three ways a drafted value cannot reach the Agent it is set on. */
type UnfitSetting = "no-setting" | "no-level" | "no-count";

/**
 * The settings a Task profile owns: the ones the panel prefills from the
 * resolved profile and re-derives when the operator moves to another Task
 * type and has not touched them.
 */
const PROFILE_KEYS = ["agentType", "model", "thinking", "contextWindow"] as const;

/** One of the Task profile's settings, by the row key that edits it. */
type ProfileKey = (typeof PROFILE_KEYS)[number];

/** Whether `key` names a setting a Task profile owns. */
function isProfileKey(key: ListKey | TextKey): key is ProfileKey {
	return (PROFILE_KEYS as readonly string[]).includes(key);
}

/** The desired label column: the widest label plus a gap. */
const LABEL_WIDTH = 12;
/** The desired value column: an agent name, a model, or an env kind. */
const VALUE_WIDTH = 30;
/** The marker column: "❯ " when the row is selected, two spaces otherwise. */
const MARKER_WIDTH = 2;
// The hint row follows the selected row. Keep both variants short enough for
// the default value column, or the guide drops on a narrow terminal.
const LIST_HINT = "move ↑↓/jk tab/⇧tab cycle ←→/hl ↵ esc";
const TEXT_HINT = "move ↑↓ tab/⇧tab edit hjkl/←→ paste ↵ esc";
/** The guide of the token-count row: it takes digits and nothing else. */
const DIGITS_HINT = "↑↓ tab/⇧tab type 0-9 ↵ esc";
/** The guide of a row whose value the chosen Agent has no setting for. */
const NO_SETTING_HINT = "no such Agent setting: Backspace clears";
/** The guide of a Thinking row whose level the chosen Agent does not offer. */
const NO_LEVEL_HINT = "no such level: cycle ←→/hl or Backspace";
/** The guide of a Context row that holds digits no count makes. */
const NO_COUNT_HINT = "not a token count: type digits above 0";
// Every hint shares one width so the guide never truncates another one, and
// a row that changes its guide does not move the rows beside it.
const HINT_WIDTH = Math.max(
	widthOf(LIST_HINT),
	widthOf(TEXT_HINT),
	widthOf(DIGITS_HINT),
	widthOf(NO_SETTING_HINT),
	widthOf(NO_LEVEL_HINT),
	widthOf(NO_COUNT_HINT),
);
const EMPTY_HINT = "(empty)";
const UNSET_HINT = "(unset)";
/**
 * The field's undo and redo keys, as a module constant so the input does not
 * rebuild its binding map on every render.
 *
 * OpenTUI's default bindings map undo and redo to the macOS super (Cmd) keys,
 * so on Linux and Windows the field would offer no usual undo or redo. Adding
 * the standard Ctrl+Z and Ctrl+Y makes the editing standard everywhere. These
 * bind to the input's own undo and redo actions.
 */
const INPUT_KEY_BINDINGS = [
	{ name: "z", ctrl: true, action: "undo" },
	{ name: "y", ctrl: true, action: "redo" },
];

/** The modal chrome: one border and one padding cell on each side. */
const CHROME = 4;

/**
 * The panel geometry sized to the terminal.
 *
 * The modal takes what the terminal holds. The value column shrinks first,
 * then the label column, then the marker. The hint row drops when its text
 * no longer fits the inner width. The rows scroll within `maxRows` when the
 * height cannot hold them all; the viewport keeps the selected row on screen.
 */
interface PanelGeometry {
	markerWidth: number;
	labelWidth: number;
	valueWidth: number;
	showHint: boolean;
	maxRows: number;
}

function panelGeometry(width: number, height: number): PanelGeometry {
	const inner = Math.max(0, width - CHROME);
	// Reserve one cell for the value before shrinking the marker at the
	// smallest renderable widths.
	const markerWidth = Math.min(MARKER_WIDTH, Math.max(0, inner - 1));
	let labelWidth = 0;
	let valueWidth = 0;
	if (inner > markerWidth) {
		const contentWidth = inner - markerWidth;
		// Keep one value cell whenever the panel has room beyond its marker.
		// The value shrinks first, then the label, while all three columns
		// continue to add up to the modal's inner width.
		valueWidth = Math.min(VALUE_WIDTH, Math.max(1, contentWidth - LABEL_WIDTH));
		labelWidth = Math.min(LABEL_WIDTH, contentWidth - valueWidth);
	}
	// The hint renders inside the modal, so it must fit the width the rows
	// use, not the terminal: a hint wider than the box would render
	// truncated, and a row never carries broken text.
	const columns = markerWidth + labelWidth + valueWidth;
	const showHint = columns >= HINT_WIDTH && height - CHROME >= 2;
	// The hint takes a row of its own; the rows need at least one.
	const maxRows = Math.max(1, height - CHROME - (showHint ? 1 : 0));
	return { markerWidth, labelWidth, valueWidth, showHint, maxRows };
}

export function OverridePanel({
	agents,
	environments,
	taskTypes,
	agentSettings,
	taskProfileChoices,
	initial,
	onConfirm,
	onCancel,
}: OverridePanelProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const geometry = panelGeometry(terminalWidth, terminalHeight);
	const [choice, setChoice] = useState<HandoffChoice>({ ...initial });
	// The selection indexes the full row list, not the visible viewport. The
	// viewport scrolls to keep this row on screen.
	const [selected, setSelected] = useState(0);

	// The key parser can deliver several key events in one tick. React batches
	// their state updates, so a closure that reads `choice` or `selected`
	// would see the stale value and drop or misaddress an update. The refs
	// mirror both, so back-to-back keys, a confirm in the same tick, and a
	// move followed by a cycle in the same tick all act on the values the
	// previous key left behind.
	const choiceRef = useRef<HandoffChoice>(choice);
	const selectedRef = useRef(0);
	// An untouched Task-profile setting follows a Task type change. Once an
	// operator changes or clears it, their one-shot override stays in force.
	// One record holds every setting the rule covers, so the next profile
	// setting is a key on it rather than a new ref, a new branch, and a new
	// spread.
	const touchedRef = useRef<Record<ProfileKey, boolean>>({
		agentType: false,
		model: false,
		thinking: false,
		contextWindow: false,
	});
	// The live text fields, one ref each, so a character a row rejects can
	// go back out of the field that holds it.
	const inputRefs: Record<TextKey, RefObject<InputRenderable | null>> = {
		model: useRef<InputRenderable | null>(null),
		thinking: useRef<InputRenderable | null>(null),
		contextWindow: useRef<InputRenderable | null>(null),
	};

	const allRowsFor = (value: HandoffChoice): PanelRow[] =>
		rowsFor(value, agents, environments, taskTypes, agentSettings);

	const allRows = allRowsFor(choice);
	// Switching the agent can hide the rows below the selection; clamp it.
	const safeSelected = Math.min(selected, allRows.length - 1);
	// The rows the terminal height holds, scrolled to keep the selected row
	// on screen. A short terminal scrolls the viewport; a row never wraps.
	const visibleCount = Math.max(1, Math.min(allRows.length, geometry.maxRows));
	let start = safeSelected >= visibleCount ? safeSelected - visibleCount + 1 : 0;
	start = Math.max(0, Math.min(start, allRows.length - visibleCount));
	const rows = allRows.slice(start, start + visibleCount);
	const row = rows[Math.max(0, safeSelected - start)];

	const commit = (update: (current: HandoffChoice) => HandoffChoice) => {
		choiceRef.current = update(choiceRef.current);
		setChoice(choiceRef.current);
	};

	// The row under the cursor, clamped the way the render clamps it.
	const cursorRow = (): PanelRow => {
		const all = allRowsFor(choiceRef.current);
		return all[Math.min(selectedRef.current, all.length - 1)];
	};

	const move = (delta: number) => {
		const count = allRowsFor(choiceRef.current).length;
		const at = Math.min(selectedRef.current, count - 1);
		selectedRef.current = (at + delta + count) % count;
		setSelected(selectedRef.current);
	};

	const cycle = (delta: number) => {
		const target = cursorRow();
		// A cycled list row is the operator's choice from then on. Only the
		// Agent and the Thinking rows are list rows among the profile's
		// settings; Environment and Task type carry no profile value.
		if (target.kind === "list" && isProfileKey(target.key)) touchedRef.current[target.key] = true;
		commit((current) => {
			const options = target.options;
			if (options === undefined) return current;
			const index = options.indexOf(current[target.key]);
			// An unset value is not an option. The first right lands on the
			// first option, the first left on the last.
			const next =
				index === -1
					? options[(delta > 0 ? 0 : options.length - 1) % options.length]
					: options[(index + delta + options.length) % options.length];
			// A setting the chosen Agent cannot map keeps its value and keeps
			// its row: the draft survives an Agent round trip, and the row stays
			// the one place the operator can clear it. See rowsFor.
			if (target.key !== "taskType") return { ...current, [target.key]: next };
			const profile = taskProfileChoices[next];
			const drafted: HandoffChoice = { ...current, taskType: next };
			// Each setting the operator never touched follows the new Task type's
			// profile; a changed or cleared one stays their one-shot override.
			if (profile !== undefined)
				for (const key of PROFILE_KEYS) if (!touchedRef.current[key]) drafted[key] = profile[key];
			return drafted;
		});
	};

	// One text field's input callback. The input owns its own caret and text,
	// so this only mirrors the value into the choice. The guard skips the
	// no-op echo the value setter emits, so a re-render never re-commits.
	const handleInput = (key: TextKey) => (text: string) => {
		// A token row takes digits and nothing else, typed or pasted: one
		// value must never become two argv elements, and a count cannot carry
		// a stray character. A count also keeps one spelling: the row folds a
		// leading zero the same way the config parser does, so what the panel
		// shows is the count the agent gets. The field owns its text, so a
		// rejected character goes back out of it: the setter echoes an input
		// event of its own, which the guard below absorbs.
		const value = key === "contextWindow" ? tokenCountDigits(text.replace(/[^0-9]/gu, "")) : text;
		if (value !== text) {
			// The row's own buffer holds a character the row refuses, so push
			// the refused text back out of it. The ref is live whenever a key
			// reached this callback, and a missing one only costs the write-back.
			const input = inputRefs[key].current;
			if (input !== null) {
				// The refused characters all stood inside the run the field just
				// inserted, so they were all before the caret. The write-back's
				// setter lands the caret at the row's end, which would move every
				// later keystroke there, so the caret goes back by their count.
				const kept = Math.max(0, input.cursorOffset - (text.length - value.length));
				input.value = value;
				input.cursorOffset = Math.min(value.length, kept);
			}
		}
		if (choiceRef.current[key] === value) {
			return;
		}
		touchedRef.current[key] = true;
		commit((current) => ({ ...current, [key]: value }));
	};

	useKeyboard((key) => {
		// Undo, redo, and the other modifier combos belong to the focused
		// input, so they fall through untouched.
		if (key.ctrl || key.meta || key.super) {
			return;
		}
		const target = cursorRow();
		// Movement and confirm/cancel are the panel's, whatever row is under
		// the cursor. They are prevented so the focused input never also
		// acts on them.
		switch (key.name) {
			case "escape":
				onCancel();
				key.preventDefault();
				return;
			case "return":
				onConfirm(choiceRef.current);
				key.preventDefault();
				return;
			case "tab":
				move(key.shift ? -1 : 1);
				key.preventDefault();
				return;
			case "down":
				move(1);
				key.preventDefault();
				return;
			case "up":
				move(-1);
				key.preventDefault();
				return;
		}
		if (target.kind === "list") {
			// A list row: left/right and h/l cycle its value, j/k move the
			// selection. Backspace and Delete clear a Thinking list row.
			if (target.key === "thinking" && (key.name === "backspace" || key.name === "delete")) {
				touchedRef.current.thinking = true;
				commit((current) => ({ ...current, thinking: "" }));
				key.preventDefault();
				return;
			}
			if (key.name === "left" || key.name === "h") {
				cycle(-1);
				key.preventDefault();
				return;
			}
			if (key.name === "right" || key.name === "l") {
				cycle(1);
				key.preventDefault();
				return;
			}
			if (key.name === "j") {
				move(1);
				key.preventDefault();
				return;
			}
			if (key.name === "k") {
				move(-1);
				key.preventDefault();
				return;
			}
			return;
		}
		// A text row: the focused input owns the caret, typing, backspace,
		// delete, Home, End, undo, redo, and paste. j, k, h, and l type into
		// it; everything else falls through. Nothing is prevented here.
	});

	return createElement(
		"box",
		{
			// A full-screen overlay above the app, with the modal centered in it.
			style: {
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				zIndex: 10,
				backgroundColor: COLORS.overlay,
				alignItems: "center",
				justifyContent: "center",
			},
		},
		createElement(
			"box",
			{
				border: true,
				borderColor: COLORS.borderFocused,
				title: "Override",
				padding: 1,
				style: { flexDirection: "column" },
			},
			...rows.map((r) =>
				rowElement(
					r,
					choice[r.key],
					r.key === row.key,
					geometry,
					handleInput,
					inputRefs[r.key as TextKey],
				),
			),
			geometry.showHint &&
				createElement(
					"text",
					{ fg: COLORS.dim },
					truncateToWidth(hintForRow(row), innerWidthOf(geometry)),
				),
		),
	);
}

/** The short control guide for the selected row. */
function hintForRow(row: PanelRow): string {
	if (row.unfit === "no-setting") return NO_SETTING_HINT;
	if (row.unfit === "no-level") return NO_LEVEL_HINT;
	if (row.unfit === "no-count") return NO_COUNT_HINT;
	if (row.digits === true) return DIGITS_HINT;
	return row.kind === "text" ? TEXT_HINT : LIST_HINT;
}

/** The inner width of the modal in cells, for the hint row. */
function innerWidthOf(geometry: PanelGeometry): number {
	return geometry.markerWidth + geometry.labelWidth + geometry.valueWidth;
}

/** The rows the panel offers for the current choice, in order. */
function rowsFor(
	choice: HandoffChoice,
	agents: readonly string[],
	environments: readonly string[],
	taskTypes: readonly string[],
	agentSettings: Readonly<Record<string, AgentSettings>>,
): PanelRow[] {
	const settings = agentSettings[choice.agentType] ?? {
		model: false,
		thinking: false,
		contextWindow: false,
	};
	const rows: PanelRow[] = [
		{ label: "Agent", key: "agentType", kind: "list", options: agents },
		{ label: "Environment", key: "environment", kind: "list", options: environments },
		{ label: "Task type", key: "taskType", kind: "list", options: taskTypes },
	];
	// A row shows when its Agent maps the setting. It also shows, wearing the
	// warning color, while it carries a value the Agent cannot take: hiding it
	// would strand that value where no key can reach it, and the panel must
	// never show something other than what the handoff sends.
	if (settings.model || choice.model !== "") {
		rows.push({
			label: "Model",
			key: "model",
			kind: "text",
			unfit: settings.model ? undefined : "no-setting",
		});
	}
	if (settings.thinking || choice.thinking !== "") {
		const list = settings.thinking !== undefined && settings.thinkingValues !== undefined;
		// An agent with a template but no value list takes any level, so only a
		// listed agent can refuse the one the chain resolved.
		const unlisted =
			list && choice.thinking !== "" && !settings.thinkingValues?.includes(choice.thinking);
		rows.push({
			label: "Thinking",
			key: "thinking",
			kind: list ? "list" : "text",
			options: list ? settings.thinkingValues : undefined,
			unfit: settings.thinking ? (unlisted ? "no-level" : undefined) : "no-setting",
		});
	}
	// The token row reads the same way as the model row: its Agent's
	// capability opens it, and a value the Agent cannot take keeps it open so
	// the operator can clear it.
	if (settings.contextWindow || choice.contextWindow !== "") {
		const count = choice.contextWindow === "" || isTokenCount(choice.contextWindow);
		rows.push({
			label: "Context",
			key: "contextWindow",
			kind: "text",
			digits: true,
			unfit: settings.contextWindow ? (count ? undefined : "no-count") : "no-setting",
		});
	}
	return rows;
}

/**
 * The color a list row's value wears.
 *
 * A value its Agent cannot take wears the warning, because the handoff sends
 * it and fails on it. A value the row simply holds no choice for is left to
 * the Agent and reads dim, and the selection brightens the row under the
 * cursor.
 */
function rowColor(row: PanelRow, inList: boolean, selected: boolean): string {
	if (row.unfit !== undefined) return COLORS.statusWarning;
	if (!inList) return COLORS.dim;
	return selected ? COLORS.textBright : COLORS.text;
}

/** One panel row as a marker, a label, and a value or an input. */
function rowElement(
	r: PanelRow,
	value: string,
	selected: boolean,
	geometry: PanelGeometry,
	handleInput: (key: TextKey) => (text: string) => void,
	inputRef: RefObject<InputRenderable | null>,
): ReactElement {
	const children: ReactElement[] = [
		createElement(
			"text",
			{ fg: selected ? COLORS.textBright : COLORS.dim },
			truncateToWidth(selected ? "❯ " : "  ", geometry.markerWidth),
		),
		createElement(
			"text",
			{ fg: selected ? COLORS.textBright : COLORS.dim },
			truncateToWidth(padToWidth(`${r.label} `, geometry.labelWidth), geometry.labelWidth),
		),
	];
	if (r.kind === "list") {
		const inList = r.options?.includes(value) ?? false;
		// A value the Agent does not offer still shows, in the warning color:
		// the handoff sends that value and fails on it, so the row must show
		// what the handoff sends. Only an empty value reads as a placeholder,
		// because an empty setting is the one the Agent owns.
		const shows = value !== "" && (inList || r.unfit !== undefined);
		children.push(
			createElement(
				"text",
				{
					width: geometry.valueWidth,
					fg: rowColor(r, inList, selected),
				},
				truncateToWidth(shows ? value : UNSET_HINT, geometry.valueWidth),
			),
		);
	} else {
		// A text row: a standard single-line input. It owns the caret, the
		// editing keys, and paste, and scrolls horizontally within the value
		// column. The empty field shows the dim placeholder, like the old
		// (empty) hint.
		children.push(
			createElement("input", {
				key: r.key,
				ref: inputRef,
				width: geometry.valueWidth,
				value,
				focused: selected,
				placeholder: EMPTY_HINT,
				placeholderColor: COLORS.dim,
				textColor: r.unfit !== undefined ? COLORS.statusWarning : COLORS.text,
				focusedTextColor: r.unfit !== undefined ? COLORS.statusWarning : COLORS.textBright,
				backgroundColor: "transparent",
				focusedBackgroundColor: COLORS.focusedBackground,
				keyBindings: INPUT_KEY_BINDINGS,
				// A token row refuses a character that is not a digit in the
				// panel's own input handler, which writes the field back without
				// it: OpenTUI offers no before-input hook to hold it out.
				onInput: handleInput(r.key as TextKey),
			}),
		);
	}
	return createElement(
		"box",
		{ key: r.key, style: { flexDirection: "row", height: 1 } },
		...children,
	);
}
