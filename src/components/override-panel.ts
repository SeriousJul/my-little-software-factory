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
 * value. The model and thinking rows accept typed text, backspace deletes.
 * Enter confirms and hands off. Esc cancels. While it is open, the keys of
 * the app below are disabled.
 */
import { createElement, useKeyboard } from "@opentui/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";
import { padToWidth, truncateToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

/** The handoff choices the panel edits. */
export interface OverrideChoice {
	agentType: string;
	environment: string;
	taskType: string;
	model: string;
	thinking: string;
}

/** Which settings an agent type maps, for hiding rows it does not support. */
export interface AgentSettings {
	model: boolean;
	thinking: boolean;
	thinkingValues?: readonly string[];
}

interface OverridePanelProps {
	agents: readonly string[];
	environments: readonly string[];
	taskTypes: readonly string[];
	agentSettings: Readonly<Record<string, AgentSettings>>;
	/** The values the panel starts on: the config defaults. */
	initial: OverrideChoice;
	onConfirm: (choice: OverrideChoice) => void;
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

/** The labels take their widest one plus a gap column. */
const LABEL_WIDTH = 12;
/** The value column is capped so the modal keeps a stable size. */
const VALUE_WIDTH = 30;
const EMPTY_HINT = "(empty)";
const UNSET_HINT = "(unset)";

export function OverridePanel({
	agents,
	environments,
	taskTypes,
	agentSettings,
	initial,
	onConfirm,
	onCancel,
}: OverridePanelProps) {
	const [choice, setChoice] = useState<OverrideChoice>({ ...initial });
	const [selected, setSelected] = useState(0);

	// The key parser can deliver several key events in one tick. React batches
	// their state updates, so a closure that reads `choice` would see the
	// stale value and drop every update but the last. The ref mirrors the
	// choice plus the updates of the current tick, so back-to-back keys and
	// a confirm in the same tick all see the final value.
	const choiceRef = useRef<OverrideChoice>(choice);

	const rows = rowsFor(choice, agents, environments, taskTypes, agentSettings);
	// Switching the agent can hide the rows below it; the selection clamps.
	const cursor = Math.min(selected, rows.length - 1);
	const row = rows[cursor];

	const commit = (update: (current: OverrideChoice) => OverrideChoice) => {
		choiceRef.current = update(choiceRef.current);
		setChoice(choiceRef.current);
	};

	const _setValue = (key: ListKey | TextKey, value: string) => {
		commit((current) => ({ ...current, [key]: value }));
	};

	const move = (delta: number) => {
		setSelected((s) => (s + delta + rows.length) % rows.length);
	};

	const cycle = (delta: number) => {
		commit((current) => {
			const options = row.options;
			if (options === undefined) {
				return current;
			}
			const index = options.indexOf(current[row.key]);
			// An unset value (the config default "") is not an option. The
			// first right lands on the first option, the first left on the last.
			if (index === -1) {
				const next = options[(delta > 0 ? 0 : options.length - 1) % options.length];
				return { ...current, [row.key]: next };
			}
			const next = options[(index + delta + options.length) % options.length];
			return { ...current, [row.key]: next };
		});
	};

	const typeText = (text: string) => {
		if (row.kind !== "text") {
			return;
		}
		commit((current) => ({ ...current, [row.key]: current[row.key] + text }));
	};

	useKeyboard((key) => {
		if (key.ctrl || key.meta) {
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
					row.kind === "text" ? { ...current, [row.key]: current[row.key].slice(0, -1) } : current,
				);
				break;
			default:
				// A printable character goes into the selected free-text row.
				if (key.name.length === 1 && key.name >= " " && key.name <= "~") {
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
				backgroundColor: COLORS.background,
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
				createElement("text", { key: r.label }, ...rowSpans(r, choice[r.key], r.key === row.key)),
			),
			createElement(
				"text",
				{ fg: COLORS.dim },
				"j/k move  left/right change  enter hand off  esc cancel",
			),
		),
	);
}

/** The rows the panel offers for the current choice, in order. */
function rowsFor(
	choice: OverrideChoice,
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

/** One panel row as spans on a stable column: marker, label, value. */
function rowSpans(r: PanelRow, value: string, selected: boolean): ReactElement[] {
	const labelFg = selected ? COLORS.textBright : COLORS.dim;
	const spans: ReactElement[] = [
		createElement(
			"span",
			{ fg: selected ? COLORS.textBright : COLORS.dim },
			selected ? "❯ " : "  ",
		),
		createElement("span", { fg: labelFg }, padToWidth(`${r.label} `, LABEL_WIDTH)),
	];
	if (r.kind === "list") {
		// A list row whose value is not an option (the config default "")
		// shows a dim hint instead of a blank.
		const inList = r.options?.includes(value) ?? false;
		spans.push(
			createElement(
				"span",
				{ fg: !inList ? COLORS.dim : selected ? COLORS.textBright : COLORS.text },
				truncateToWidth(inList ? value : UNSET_HINT, VALUE_WIDTH),
			),
		);
	} else {
		const shown = value === "" ? EMPTY_HINT : value;
		spans.push(
			createElement(
				"span",
				{ fg: value === "" ? COLORS.dim : selected ? COLORS.textBright : COLORS.text },
				truncateToWidth(shown, VALUE_WIDTH),
			),
		);
	}
	return spans;
}
