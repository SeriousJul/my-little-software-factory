/**
 * The override panel: a one-shot change to the settings of a single
 * handoff, made before the handoff starts. It applies to that handoff only
 * and never becomes a new default.
 *
 * It is a centered modal with one row per setting: the agent type, the
 * environment kind, the task type, and the settings the chosen agent type
 * maps. A setting the agent does not map is hidden, so the panel shows only
 * what the chosen agent supports. The model row accepts free text; the
 * thinking row takes the agent's value list when it has one and free text
 * otherwise.
 *
 * The keys: j/k and up/down move the rows. left/right and h/l cycle a list
 * value. A selected free-text row owns j, k, h, and l: they type into it.
 * The arrow keys keep their movement, so a text row can always be left.
 * Backspace deletes. Enter confirms and hands off. Esc cancels. While it is
 * open, the keys of the app below are disabled.
 *
 * The panel sizes itself to the terminal: the value column shrinks first,
 * then the label column, then the marker. The hint row and the last rows
 * drop when the terminal cannot hold them. A row never wraps or interleaves:
 * it carries less, not broken text.
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
// The hint row documents every key group the panel owns: the movement
// keys, the list cycle keys, and the typed text of the free-text rows. It
// must fit the modal's column width at the default geometry, or it drops.
const HINT = "j/k move  h/l cycle  type text  enter esc";
const EMPTY_HINT = "(empty)";
const UNSET_HINT = "(unset)";

/** The modal chrome: one border and one padding cell on each side. */
const CHROME = 4;

/**
 * The panel geometry sized to the terminal.
 *
 * The modal takes what the terminal holds. The value column shrinks first,
 * then the label column, then the marker. The hint row drops when its text
 * no longer fits the inner width, and the rows drop from the last when the
 * height cannot hold them all. The row never wraps.
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
	let markerWidth = MARKER_WIDTH;
	let labelWidth = LABEL_WIDTH;
	let valueWidth = VALUE_WIDTH;
	if (markerWidth + labelWidth + valueWidth > inner) {
		valueWidth = Math.max(0, inner - markerWidth - labelWidth);
	}
	if (markerWidth + labelWidth > inner) {
		labelWidth = Math.max(0, inner - markerWidth);
		valueWidth = 0;
	}
	if (markerWidth > inner) {
		markerWidth = inner;
		labelWidth = 0;
	}
	// The hint renders inside the modal, so it must fit the width the rows
	// use, not the terminal: a hint wider than the box would render
	// truncated, and a row never carries broken text.
	const columns = markerWidth + labelWidth + valueWidth;
	const showHint = columns >= widthOf(HINT) && height - CHROME >= 2;
	// The hint takes a row of its own; the rows need at least one.
	const maxRows = Math.max(1, height - CHROME - (showHint ? 1 : 0));
	return { markerWidth, labelWidth, valueWidth, showHint, maxRows };
}

export function OverridePanel({
	agents,
	environments,
	taskTypes,
	agentSettings,
	initial,
	onConfirm,
	onCancel,
}: OverridePanelProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const geometry = panelGeometry(terminalWidth, terminalHeight);
	const [choice, setChoice] = useState<HandoffChoice>({ ...initial });
	const [selected, setSelected] = useState(0);

	// The key parser can deliver several key events in one tick. React batches
	// their state updates, so a closure that reads `choice` or `selected`
	// would see the stale value and drop or misaddress an update. The refs
	// mirror both, so back-to-back keys, a confirm in the same tick, and a
	// move followed by a cycle in the same tick all act on the values the
	// previous key left behind.
	const choiceRef = useRef<HandoffChoice>(choice);
	const selectedRef = useRef(0);

	const allRows = rowsFor(choice, agents, environments, taskTypes, agentSettings);
	// The terminal too short for every row drops the last one, the settings
	// before the core choices.
	const rows = allRows.slice(0, geometry.maxRows);
	// Switching the agent can hide the rows below it; the selection clamps.
	const cursor = Math.min(selected, rows.length - 1);
	const row = rows[cursor];

	const commit = (update: (current: HandoffChoice) => HandoffChoice) => {
		choiceRef.current = update(choiceRef.current);
		setChoice(choiceRef.current);
	};

	// The rows as the keys see them, from the mirrored choice: a key of the
	// current tick must act on the rows the previous key of the same tick
	// left behind, and the render closure would still hold the old ones.
	const visibleRows = (): PanelRow[] =>
		rowsFor(choiceRef.current, agents, environments, taskTypes, agentSettings).slice(
			0,
			geometry.maxRows,
		);

	// The row under the cursor, clamped the way the render clamps it.
	const cursorRow = (): PanelRow => {
		const visible = visibleRows();
		return visible[Math.min(selectedRef.current, visible.length - 1)];
	};

	const move = (delta: number) => {
		const count = visibleRows().length;
		const at = Math.min(selectedRef.current, count - 1);
		selectedRef.current = (at + delta + count) % count;
		setSelected(selectedRef.current);
	};

	const cycle = (delta: number) => {
		const target = cursorRow();
		commit((current) => {
			const options = target.options;
			if (options === undefined) {
				return current;
			}
			const index = options.indexOf(current[target.key]);
			// An unset value (the config default "") is not an option. The
			// first right lands on the first option, the first left on the last.
			if (index === -1) {
				const next = options[(delta > 0 ? 0 : options.length - 1) % options.length];
				return { ...current, [target.key]: next };
			}
			const next = options[(index + delta + options.length) % options.length];
			return { ...current, [target.key]: next };
		});
	};

	const typeText = (text: string) => {
		const target = cursorRow();
		if (target.kind !== "text") {
			return;
		}
		commit((current) => ({ ...current, [target.key]: current[target.key] + text }));
	};

	useKeyboard((key) => {
		if (key.ctrl || key.meta) {
			return;
		}
		const target = cursorRow();
		// A selected text row owns j, k, h, and l: they type into it. The
		// arrows keep their movement, so the row can always be left.
		if (
			target.kind === "text" &&
			(key.name === "j" || key.name === "k" || key.name === "h" || key.name === "l")
		) {
			typeText(key.name);
			return;
		}
		switch (key.name) {
			case "escape":
				onCancel();
				break;
			case "return":
				onConfirm(choiceRef.current);
				break;
			case "j":
			case "down":
				move(1);
				break;
			case "k":
			case "up":
				move(-1);
				break;
			case "h":
			case "left":
				cycle(-1);
				break;
			case "l":
			case "right":
				cycle(1);
				break;
			case "backspace":
				commit((current) =>
					target.kind === "text"
						? { ...current, [target.key]: current[target.key].slice(0, -1) }
						: current,
				);
				break;
			default:
				// A printable character goes into the selected free-text row.
				// Any script is accepted, not only the ASCII range: a model
				// name in another script is still a model name. Named keys
				// carry a name of several characters, and a control character
				// is never printable.
				if ([...key.name].length === 1 && !/\p{Cc}/u.test(key.name)) {
					typeText(key.name);
				}
				break;
		}
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
				createElement(
					"text",
					{ key: r.label },
					...rowSpans(r, choice[r.key], r.key === row.key, geometry),
				),
			),
			geometry.showHint &&
				createElement("text", { fg: COLORS.dim }, truncateToWidth(HINT, innerWidthOf(geometry))),
		),
	);
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

/** One panel row as spans on the columns the terminal width allows. */
function rowSpans(
	r: PanelRow,
	value: string,
	selected: boolean,
	geometry: PanelGeometry,
): ReactElement[] {
	const labelFg = selected ? COLORS.textBright : COLORS.dim;
	const spans: ReactElement[] = [
		createElement(
			"span",
			{ fg: selected ? COLORS.textBright : COLORS.dim },
			truncateToWidth(selected ? "❯ " : "  ", geometry.markerWidth),
		),
		createElement(
			"span",
			{ fg: labelFg },
			truncateToWidth(padToWidth(`${r.label} `, geometry.labelWidth), geometry.labelWidth),
		),
	];
	if (r.kind === "list") {
		// A list row whose value is not an option (the config default "")
		// shows a dim hint instead of a blank.
		const inList = r.options?.includes(value) ?? false;
		spans.push(
			createElement(
				"span",
				{ fg: !inList ? COLORS.dim : selected ? COLORS.textBright : COLORS.text },
				truncateToWidth(inList ? value : UNSET_HINT, geometry.valueWidth),
			),
		);
	} else {
		const shown = value === "" ? EMPTY_HINT : value;
		spans.push(
			createElement(
				"span",
				{ fg: value === "" ? COLORS.dim : selected ? COLORS.textBright : COLORS.text },
				truncateToWidth(shown, geometry.valueWidth),
			),
		);
	}
	return spans;
}
