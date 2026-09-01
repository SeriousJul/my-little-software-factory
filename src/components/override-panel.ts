/**
 * The override panel: a one-shot change to the settings of a single
 * handoff, made before the handoff starts. It applies to that handoff only
 * and never becomes a new default.
 *
 * It is a centered modal with one row per setting: the agent type, the
 * environment kind, the task type, and the settings the chosen agent type
 * maps. A setting the agent does not map is hidden, so the panel shows only
 * what the chosen agent supports.
 *
 * The Model row and the free-text Thinking row are standard single-line
 * inputs. They show a caret, and take typing, caret movement with the
 * arrows, Home and End, selection, backspace and delete, undo and redo, and
 * bracketed terminal paste. A paste is sanitized by the input before it is
 * inserted: ANSI escape sequences and line breaks are stripped, so a pasted
 * model name is plain text. An input scrolls horizontally within its column
 * and never wraps, so it can never corrupt the rows around it.
 *
 * A list row (agent, environment, task type, and the thinking value when the
 * agent has a value list) cycles its value with left/right and h/l.
 *
 * The keys: up/down and tab/shift+tab move the row selection. j and k move
 * it too, except on a selected text row, where they type. left/right move
 * the caret on a text row and cycle a list row's value; h and l type on a
 * text row and cycle a list row's value. The input owns everything else:
 * typing, backspace, delete, Home, End, undo, redo, and paste. The thinking
 * row starts on the suggested task type's thinking default, and switching
 * the task type re-derives it while the operator has not set the row, so
 * the panel always shows what the handoff will run on. Clearing a free-text
 * row leaves the setting to the agent. Enter confirms and hands off. Esc
 * cancels. While it is open, the keys of the app below are disabled.
 *
 * The panel sizes itself to the terminal: the value column shrinks first,
 * then the label column, then the marker. The hint row drops when the
 * terminal cannot hold it, and the rows scroll within the viewport when the
 * height cannot hold them all: the selected row always stays on screen. A
 * row never wraps or interleaves.
 */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactElement, useRef, useState } from "react";

import type { EnvironmentKind } from "../domain/ticket.ts";
import type { HandoffChoice } from "../handoff.ts";
import { padToWidth, truncateToWidth, widthOf } from "./text.ts";
import { COLORS } from "./theme.ts";

/** Which settings an agent type maps, for hiding rows it does not support. */
export interface AgentSettings {
	model: boolean;
	thinking: boolean;
	thinkingValues?: readonly string[];
}

interface OverridePanelProps {
	agents: readonly string[];
	environments: readonly EnvironmentKind[];
	taskTypes: readonly string[];
	agentSettings: Readonly<Record<string, AgentSettings>>;
	/** The task types' thinking defaults, keyed by task type name. */
	thinkingDefaults: Readonly<Record<string, string | undefined>>;
	/** The values the panel starts on: the config defaults. */
	initial: HandoffChoice;
	onConfirm: (choice: HandoffChoice) => void;
	onCancel: () => void;
}

type ListKey = "agentType" | "environment" | "taskType";
type TextKey = "model" | "thinking";

interface PanelRow {
	label: string;
	key: ListKey | TextKey;
	kind: "list" | "text";
	options?: readonly string[];
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
const HINT_WIDTH = Math.max(widthOf(LIST_HINT), widthOf(TEXT_HINT));
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
	thinkingDefaults,
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
	// True once the operator sets the thinking row themselves. While it
	// stays false, switching the task type re-derives the row from the new
	// task type's default, so the panel keeps showing what the handoff will
	// run on.
	const thinkingTouchedRef = useRef(false);

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
		if (target.kind === "list" && target.key === "thinking") {
			thinkingTouchedRef.current = true;
		}
		commit((current) => {
			const options = target.options;
			if (options === undefined) {
				return current;
			}
			const index = options.indexOf(current[target.key]);
			// An unset value (the config default "") is not an option. The
			// first right lands on the first option, the first left on the last.
			const next =
				index === -1
					? options[(delta > 0 ? 0 : options.length - 1) % options.length]
					: options[(index + delta + options.length) % options.length];
			// Switching the task type re-derives an untouched thinking row,
			// so the row keeps showing what the handoff will run on.
			if (target.key === "taskType" && !thinkingTouchedRef.current) {
				return { ...current, taskType: next, thinking: thinkingDefaults[next] ?? "" };
			}
			return { ...current, [target.key]: next };
		});
	};

	// One text field's input callback. The input owns its own caret and text,
	// so this only mirrors the value into the choice. The guard skips the
	// no-op echo the value setter emits, so a re-render never re-commits.
	const handleInput = (key: TextKey) => (value: string) => {
		if (choiceRef.current[key] === value) {
			return;
		}
		if (key === "thinking") {
			thinkingTouchedRef.current = true;
		}
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
			// selection. No input is focused here, so anything else has
			// nowhere to go and is dropped.
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
			...rows.map((r) => rowElement(r, choice[r.key], r.key === row.key, geometry, handleInput)),
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
	const settings = agentSettings[choice.agentType] ?? { model: false, thinking: false };
	const rows: PanelRow[] = [
		{ label: "Agent", key: "agentType", kind: "list", options: agents },
		{ label: "Environment", key: "environment", kind: "list", options: environments },
		{ label: "Task type", key: "taskType", kind: "list", options: taskTypes },
	];
	if (settings.model) {
		rows.push({ label: "Model", key: "model", kind: "text" });
	}
	if (settings.thinking) {
		rows.push({
			label: "Thinking",
			key: "thinking",
			kind: settings.thinkingValues !== undefined ? "list" : "text",
			options: settings.thinkingValues,
		});
	}
	return rows;
}

/** One panel row as a marker, a label, and a value or an input. */
function rowElement(
	r: PanelRow,
	value: string,
	selected: boolean,
	geometry: PanelGeometry,
	handleInput: (key: TextKey) => (value: string) => void,
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
		// A list row whose value is not an option (the config default "")
		// shows a dim hint instead of a blank.
		const inList = r.options?.includes(value) ?? false;
		children.push(
			createElement(
				"text",
				{
					width: geometry.valueWidth,
					fg: !inList ? COLORS.dim : selected ? COLORS.textBright : COLORS.text,
				},
				truncateToWidth(inList ? value : UNSET_HINT, geometry.valueWidth),
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
				width: geometry.valueWidth,
				value,
				focused: selected,
				placeholder: EMPTY_HINT,
				placeholderColor: COLORS.dim,
				textColor: COLORS.text,
				focusedTextColor: COLORS.textBright,
				backgroundColor: "transparent",
				focusedBackgroundColor: COLORS.focusedBackground,
				keyBindings: INPUT_KEY_BINDINGS,
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
