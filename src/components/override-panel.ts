/**
 * The override panel: a one-shot change to the settings of a single handoff,
 * made before the handoff starts. It applies to that handoff only and never
 * becomes a new default.
 *
 * It is a centered modal with one row per setting: the agent type, the
 * environment kind, the task type, the model, the thinking level, and the
 * maximum context window. A row shows when its agent maps the setting. It
 * also shows, in the warning color, while it carries a value the agent cannot
 * take: hiding it would strand that value where no key can reach it, and the
 * panel must never show anything other than what the handoff sends. The rows
 * start on the settings the resolved task profile names (ADR 0009), so the
 * panel shows what the handoff will run on.
 *
 * The Model row offers the selected agent's Model list (ADR 0010). It is a
 * list row that also takes type-ahead: each typed letter extends the typed
 * text, and the row jumps to the first model whose whole value contains that
 * text, case-insensitive. The typed text is never displayed; the jumping
 * value is the feedback. A run that finds nothing is over, because a longer
 * run can only match less, so the letter that found nothing starts a new run
 * and every letter the operator types is answered. Typing accumulates until
 * the operator selects with the arrows, clears with backspace, or leaves the
 * row. While the control plane fetches the list the row shows a dim loading
 * marker and takes no input; when the agent's kind reports no list, or the
 * fetch failed, the row is the standard single-line Text field: typing, caret
 * movement with the arrows, Home and End, selection, backspace and delete,
 * undo and redo, and bracketed terminal paste, and its guide line names the
 * reason the list is gone. A paste is sanitized by the input before it is
 * inserted, so a pasted model name is plain text. An input scrolls horizontally
 * within its column and never wraps, so it can never corrupt the rows around
 * it.
 *
 * A list row (the agent, the environment, the task type, the Model list, and
 * the thinking level) cycles its value with left/right, and h and l where
 * those keys do not type. Backspace or Delete clears a Model or Thinking row,
 * which leaves that setting to the agent. The agent, environment, task type,
 * and thinking rows are pure cycling; only the Model list row takes typed
 * letters. The Context row is a token field: it takes digits and nothing else,
 * typed or pasted, because a count cannot carry a stray character and one
 * value must never become two argv elements. It folds a leading zero the same
 * way the config parser does, so what the panel shows is the count the agent
 * gets.
 *
 * A value that is set but cannot reach the current agent renders in the
 * warning color, and its guide names the way out: a row whose agent maps no
 * template for the setting clears with backspace, a listed row that holds a
 * level the agent does not offer cycles or clears, and a context row that
 * holds no count takes digits. The panel's own check is the same one the
 * handoff's preflight runs, so a handoff the panel shows as doomed is the one
 * the preflight refuses. A row whose list has not arrived is not judged at
 * all: it holds its value in the dim tone the panel uses for a setting it
 * cannot confirm, and its guide names the wait. A model value wider than the
 * column shows its end, where a real agent list tells its models apart, with
 * a leading marker for the cut; the whole value still rides on the handoff.
 *
 * The keys: up/down and tab/shift+tab move the row selection. j and k move it
 * too, except on a row that takes typing (a Text field, or the Model list),
 * where they type. left/right move the caret on a Text field and cycle a list
 * row's value; h and l type on a Text field and on the Model list, and cycle
 * every other list row. Switching the task type re-derives the agent, model,
 * thinking, and context rows from the new task type's profile while the
 * operator has not touched each row, so the panel keeps showing the true
 * start values; a row the operator touched keeps its value. Switching the
 * agent never re-derives the model: each setting resolves on its own chain.
 * Enter confirms and hands off. Esc cancels. While the panel is open, the
 * keys of the app below are disabled.
 *
 * The panel sizes itself to the terminal: the value column shrinks first, then
 * the label column, then the marker. The hint row drops when the terminal
 * cannot hold it, and the rows scroll within the viewport when the height
 * cannot hold them all: the selected row always stays on screen. A row never
 * wraps or interleaves.
 */

import type { InputRenderable } from "@opentui/core";
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactElement, type RefObject, useRef, useState } from "react";
import type { ThinkingLevel } from "../domain/agent.ts";
import { isTokenCount, tokenCountDigits } from "../domain/settings.ts";
import type { EnvironmentKind } from "../domain/ticket.ts";
import type { HandoffChoice } from "../handoff.ts";
import type { TaskProfileStart } from "../setting-resolution.ts";
import { padToWidth, truncateTailToWidth, truncateToWidth, widthOf } from "./text.ts";
import { COLORS } from "./theme.ts";

/** Which settings an agent type maps, for the rows it opens. */
export interface AgentSettings {
	model: boolean;
	thinking: boolean;
	/** Whether a maximum context window can reach this agent type. */
	contextWindow?: boolean;
	/** The levels this Agent type supports, in the order the row offers them. */
	thinkingValues?: readonly ThinkingLevel[];
}

/**
 * Why a Model row is a Text field instead of the selected agent's list.
 *
 * The two causes read alike on the row itself, so the guide line names which
 * one applies: a kind that reports no list is normal for that agent, while a
 * query that failed says a list should be there and is not. The long reason a
 * query came back with is reported once at boot, on stderr, where a whole
 * command failure fits; a guide line holds 41 cells and a cut-off failure
 * explains nothing.
 */
export type ModelListCause =
	/** The agent kind's own CLI has no list command, so no query ran. */
	| "no-list"
	/** The query ran and did not answer: a failed command or an unreadable table. */
	| "query-failed";

/**
 * One agent's Model list, as the control plane fetched it (ADR 0010).
 * `unavailable` covers both an agent kind that reports no list and a fetch
 * that failed: either way the row is a Text field, and it says which.
 */
export type ModelListStatus =
	| { status: "loading" }
	| { status: "available"; models: readonly string[] }
	| { status: "unavailable"; cause: ModelListCause };

/** The list of the agent the panel is on, tagged so a stale answer cannot show. */
export interface AgentModelList {
	agentType: string;
	status: ModelListStatus;
}

/** The setting one row edits. */
type RowKey = keyof HandoffChoice;
/** The rows whose value the operator can clear to leave the setting to the agent. */
type ClearKey = "model" | "thinking";
/** The rows whose value a text field edits. */
type TextKey = "model" | "thinking" | "contextWindow";
/** The rows a task type switch re-derives from its profile: every setting with a value. */
type DerivedKey = Exclude<RowKey, "environment" | "taskType">;

/**
 * The three ways a drafted value cannot reach the agent it is set on, so the
 * row can wear the warning and name the fix.
 */
type UnfitSetting = "no-setting" | "no-level" | "no-count";

interface PanelRow {
	label: string;
	key: RowKey;
	/** "list" cycles, "text" edits, "pending" waits for a list and takes nothing. */
	kind: "list" | "text" | "pending";
	options?: readonly string[];
	/** The Model list row: a list row that also takes typed letters. */
	typeAhead?: boolean;
	/** Show the end of a value that does not fit, where a model name differs. */
	clipTail?: boolean;
	/** The dim marker a row holds while it has no value to show. */
	placeholder?: string;
	/**
	 * The cause a Model row has no list to offer, for its guide line. Only a
	 * free-text Model row carries one.
	 */
	fallbackCause?: ModelListCause;
	/**
	 * Why this row's value cannot reach the selected agent, and so cannot
	 * survive a handoff. Undefined means the agent takes the value as it is.
	 */
	unfit?: UnfitSetting;
	/** True when the row is a text field that takes digits and nothing else. */
	digits?: boolean;
}

interface OverridePanelProps {
	agents: readonly string[];
	environments: readonly EnvironmentKind[];
	taskTypes: readonly string[];
	agentSettings: Readonly<Record<string, AgentSettings>>;
	/** What each task type's profile starts its handoffs on (ADR 0009). */
	profiles: Readonly<Record<string, TaskProfileStart>>;
	/** The Model list of the agent the panel is on. */
	modelList: AgentModelList;
	/** Tell the control plane the operator selected another agent: it fetches that agent's Model list. */
	onAgentChange: (agentType: string) => void;
	/** The values the panel starts on: the resolved task profile. */
	initial: HandoffChoice;
	onConfirm: (choice: HandoffChoice) => void;
	onCancel: () => void;
}

/** The desired label column: the widest label plus a gap. */
const LABEL_WIDTH = 12;
/** The desired value column: an agent name, a model, or an env kind. */
const VALUE_WIDTH = 30;
/** The marker column: "❯ " when the row is selected, two spaces otherwise. */
const MARKER_WIDTH = 2;
// Every hint shares one width so the guide never truncates another one, and a
// row that changes its guide does not move the rows beside it. Keep them all
// inside that width, or the guide drops on a normal terminal.
const LIST_HINT = "move ↑↓/jk tab/⇧tab cycle ←→/hl ↵ esc";
/**
 * The guide of a free-text Model row: the text keys, and why the list is gone.
 *
 * A Model row is a Text field only because its agent's list is missing, so the
 * guide spends one cell group on the fact the row cannot show by itself.
 */
const NO_LIST_HINT = "↑↓ move edit hjkl/←→ paste ↵/esc (none)";
const LIST_FAILED_HINT = "↑↓ move edit hjkl/←→ paste ↵/esc (failed)";
/** A list row the operator can also clear, leaving the setting to the agent. */
const CHOICE_HINT = "↑↓/jk move ←→/hl cycle ⌫ clear ↵/esc";
/**
 * The Model list row: typing jumps the value, the arrows take a match.
 *
 * It names confirm and cancel like every other guide. Tab moves rows too, but
 * the arrows are the keys the row is steered with.
 */
const MODEL_HINT = "↑↓ move type jumps ←→ cycle ⌫ clear ↵/esc";
/**
 * The row that waits for its agent's Model list. Only the movement keys and
 * confirm and cancel reach it, and the guide says why: the loading marker is
 * how the row tells an operator that a value filling its column is a value the
 * panel has not judged yet, not a row that works.
 */
const PENDING_HINT = "↑↓/jk move (loading...) ↵/esc";
/** The guide of the token-count row: it takes digits and nothing else. */
const DIGITS_HINT = "↑↓ tab/⇧tab type 0-9 ↵ esc";
/** The guide of a row whose value the chosen agent has no setting for. */
const NO_SETTING_HINT = "no such Agent setting: Backspace clears";
/** The guide of a Thinking row whose level the chosen agent does not offer. */
const NO_LEVEL_HINT = "no such level: cycle ←→/hl or Backspace";
/** The guide of a Context row that holds digits no count makes. */
const NO_COUNT_HINT = "not a token count: type digits above 0";
const HINT_WIDTH = Math.max(
	widthOf(LIST_HINT),
	widthOf(NO_LIST_HINT),
	widthOf(LIST_FAILED_HINT),
	widthOf(CHOICE_HINT),
	widthOf(MODEL_HINT),
	widthOf(PENDING_HINT),
	widthOf(DIGITS_HINT),
	widthOf(NO_SETTING_HINT),
	widthOf(NO_LEVEL_HINT),
	widthOf(NO_COUNT_HINT),
);
const EMPTY_HINT = "(empty)";
const UNSET_HINT = "(unset)";
const LOADING_HINT = "(loading...)";
const NO_MODELS_HINT = "(no models available)";
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

/**
 * The cells one terminal size gives a row's value.
 *
 * The panel owns its geometry, so a test that checks a clipped value asks the
 * panel how wide the column is instead of mirroring the number by hand.
 */
export function panelValueCells(width: number, height: number): number {
	return panelGeometry(width, height).valueWidth;
}

/**
 * The one character a key types, or null when it types nothing.
 *
 * Named keys arrive as their word ("up", "return"), and the arrows and the
 * editing keys as a multi-cell escape sequence, so a single printable cell is
 * the only thing that extends the typed text. The modifier combos belong to
 * the focused input and never reach here.
 */
function typedChar(key: { name: string; sequence?: string }): string | null {
	const raw = key.sequence === undefined || key.sequence === "" ? key.name : key.sequence;
	if (raw.length !== 1) return null;
	const code = raw.charCodeAt(0);
	// A space or a control character types nothing the operator meant.
	return code > 0x20 && code < 0x7f ? raw : null;
}

/**
 * The first model whose whole value holds the typed text, case-insensitive.
 *
 * A plain substring test, and so stricter than the pattern search `pi
 * --list-models` applies, which lets the matched letters sit apart from each
 * other: `pi --list-models snnet` answers with models that do not hold the
 * substring. The panel keeps the stricter rule because a jump is the only
 * feedback it gives, and a jump must always name a model the typed letters
 * really hold. A run that finds nothing here ends: `typeLetter` starts a new
 * one at the letter that failed.
 */
function typeAheadMatch(options: readonly string[], typed: string): string | undefined {
	const needle = typed.toLowerCase();
	return options.find((option) => option.toLowerCase().includes(needle));
}

export function OverridePanel({
	agents,
	environments,
	taskTypes,
	agentSettings,
	profiles,
	modelList,
	onAgentChange,
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
	const touchedRef = useRef<Record<DerivedKey, boolean>>({
		agentType: false,
		model: false,
		thinking: false,
		contextWindow: false,
	});
	// The Model row's accumulated type-ahead text. It is never displayed: the
	// value jumping to a match is the feedback.
	const typedRef = useRef("");
	// The live text fields, one ref each, so a character a row rejects can
	// go back out of the field that holds it.
	const inputRefs: Record<TextKey, RefObject<InputRenderable | null>> = {
		model: useRef<InputRenderable | null>(null),
		thinking: useRef<InputRenderable | null>(null),
		contextWindow: useRef<InputRenderable | null>(null),
	};

	const rowsForChoice = (value: HandoffChoice): PanelRow[] =>
		rowsFor(value, agents, environments, taskTypes, agentSettings, listFor(value, modelList));

	const allRows = rowsForChoice(choice);
	// Switching the agent can hide the rows below the selection; clamp it.
	const safeSelected = Math.min(selected, allRows.length - 1);
	// The rows the terminal height holds, scrolled to keep the selected row
	// on screen. A short terminal scrolls the viewport; a row never wraps.
	const visibleCount = Math.max(1, Math.min(allRows.length, geometry.maxRows));
	let start = safeSelected >= visibleCount ? safeSelected - visibleCount + 1 : 0;
	start = Math.max(0, Math.min(start, allRows.length - visibleCount));
	const rows = allRows.slice(start, start + visibleCount);
	const row = rows[Math.max(0, safeSelected - start)];

	/** Move to another agent: its Model list is the one the row must offer. */
	const selectAgent = (next: HandoffChoice, previous: HandoffChoice) => {
		if (next.agentType !== previous.agentType) onAgentChange(next.agentType);
	};

	const commit = (update: (current: HandoffChoice) => HandoffChoice) => {
		const previous = choiceRef.current;
		choiceRef.current = update(previous);
		setChoice(choiceRef.current);
		selectAgent(choiceRef.current, previous);
	};

	// The row under the cursor, clamped the way the render clamps it.
	const cursorRow = (): PanelRow => {
		const all = rowsForChoice(choiceRef.current);
		return all[Math.min(selectedRef.current, all.length - 1)];
	};

	const move = (delta: number) => {
		// Leaving a row ends its type-ahead run: the next row starts clean.
		typedRef.current = "";
		const count = rowsForChoice(choiceRef.current).length;
		const at = Math.min(selectedRef.current, count - 1);
		selectedRef.current = (at + delta + count) % count;
		setSelected(selectedRef.current);
	};

	/**
	 * The rows a task type switch re-derives: every setting the operator has
	 * not touched, from the new task type's profile (ADR 0009). A touched row
	 * keeps the operator's value.
	 */
	const reDerive = (current: HandoffChoice, taskType: string): HandoffChoice => {
		const profile = profiles[taskType];
		if (profile === undefined) return { ...current, taskType };
		const touched = touchedRef.current;
		return {
			...current,
			taskType,
			agentType: touched.agentType ? current.agentType : profile.agentType,
			model: touched.model ? current.model : profile.model,
			thinking: touched.thinking ? current.thinking : profile.thinking,
			contextWindow: touched.contextWindow ? current.contextWindow : profile.contextWindow,
		};
	};

	const cycle = (delta: number) => {
		const target = cursorRow();
		if (target.kind !== "list") return;
		const options = target.options;
		if (options === undefined || options.length === 0) return;
		// Choosing with the arrows ends the type-ahead run.
		typedRef.current = "";
		if (target.key !== "environment" && target.key !== "taskType") touch(target.key);
		commit((current) => {
			const index = options.indexOf(current[target.key]);
			// An unset value (the empty string a cleared row leaves) is not an
			// option. The first right lands on the first option, the first left
			// on the last.
			const next =
				index === -1
					? options[(delta > 0 ? 0 : options.length - 1) % options.length]
					: options[(index + delta + options.length) % options.length];
			if (target.key === "taskType") return reDerive(current, next);
			return { ...current, [target.key]: next };
		});
	};

	/** Record that the operator set one of the rows a task type switch re-derives. */
	const touch = (key: DerivedKey) => {
		touchedRef.current[key] = true;
	};

	/** Backspace or Delete on a Model or Thinking row: leave the setting to the agent. */
	const clearRow = () => {
		const target = cursorRow();
		if (target.key !== "model" && target.key !== "thinking") return;
		const key: ClearKey = target.key;
		typedRef.current = "";
		touch(key);
		commit((current) => (current[key] === "" ? current : { ...current, [key]: "" }));
	};

	/** One type-ahead letter on the Model list row. */
	const typeLetter = (char: string) => {
		const target = cursorRow();
		const options = target.options ?? [];
		const extended = typedRef.current + char;
		// Containment only gets harder as a run grows, so a run that has found
		// nothing can never find something again. The letter that ended it
		// starts a new run instead: every letter is answered, one mistyped one
		// cannot freeze the row, and the value jumping is the signal that the
		// run restarted.
		const match = typeAheadMatch(options, extended) ?? typeAheadMatch(options, char);
		typedRef.current = match === undefined ? char : extended;
		touch("model");
		// A letter no model holds, on its own or in a run, leaves the value where
		// it is.
		if (match === undefined) return;
		commit((current) => (current.model === match ? current : { ...current, model: match }));
	};

	// One text field's input callback. The input owns its own caret and text,
	// so this only mirrors the value into the choice. The guard skips the
	// no-op echo the input emits, so a re-render never re-commits.
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
		touch(key);
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
		if (target.kind === "pending") {
			// The Model list has not arrived: the row takes no input at all, so
			// nothing the operator means for it can be lost. Only j and k still
			// move the selection off the row.
			if (key.name === "j" || key.name === "k") {
				move(key.name === "j" ? 1 : -1);
			}
			key.preventDefault();
			return;
		}
		if (target.kind === "list") {
			// The Model list row takes typed letters before anything else, so h,
			// j, k, and l type into it instead of cycling or moving.
			if (target.typeAhead === true) {
				const char = typedChar(key);
				if (char !== null) {
					typeLetter(char);
					key.preventDefault();
					return;
				}
			} else if (key.name === "j") {
				move(1);
				key.preventDefault();
				return;
			} else if (key.name === "k") {
				move(-1);
				key.preventDefault();
				return;
			}
			if (key.name === "left" || (target.typeAhead !== true && key.name === "h")) {
				cycle(-1);
				key.preventDefault();
				return;
			}
			if (key.name === "right" || (target.typeAhead !== true && key.name === "l")) {
				cycle(1);
				key.preventDefault();
				return;
			}
			if (key.name === "backspace" || key.name === "delete") {
				// A list row has no caret, so forward delete and backspace are the
				// same decision: clear the setting, and leave it to the agent.
				clearRow();
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
				rowElement(r, choice[r.key], r.key === row.key, geometry, handleInput, inputRefs),
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

/**
 * The Model list status that belongs to the agent the panel is on.
 *
 * A list the control plane is still fetching, or one it tagged for another
 * agent, reads as loading: the row never offers agent A's models while agent B
 * is selected. The control plane drops a stale answer before it reaches here,
 * and the panel checks the tag too, because the row's contract is its own: an
 * answer for the wrong agent is not an answer.
 */
function listFor(choice: HandoffChoice, modelList: AgentModelList): ModelListStatus {
	return modelList.agentType === choice.agentType ? modelList.status : { status: "loading" };
}

/** The short control guide for the selected row. */
function hintForRow(row: PanelRow): string {
	if (row.unfit === "no-setting") return NO_SETTING_HINT;
	if (row.unfit === "no-level") return NO_LEVEL_HINT;
	if (row.unfit === "no-count") return NO_COUNT_HINT;
	switch (row.kind) {
		case "text":
			// A Model row reaches a Text field only through a missing list, so the
			// row always carries which cause sent it there; a text row without
			// one is the token row, and its guide names the digits rule.
			return row.fallbackCause === "query-failed"
				? LIST_FAILED_HINT
				: row.fallbackCause === "no-list"
					? NO_LIST_HINT
					: DIGITS_HINT;
		case "pending":
			return PENDING_HINT;
		default:
			if (row.typeAhead === true) return MODEL_HINT;
			return row.key === "thinking" ? CHOICE_HINT : LIST_HINT;
	}
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
	modelStatus: ModelListStatus,
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
	// A row shows when its agent maps the setting. It also shows, wearing the
	// warning color, while it carries a value the agent cannot take: hiding it
	// would strand that value where no key can reach it, and the panel must
	// never show something other than what the handoff sends.
	if (settings.model) {
		rows.push(modelRow(modelStatus));
	} else if (choice.model !== "") {
		rows.push({ label: "Model", key: "model", kind: "text", unfit: "no-setting" });
	}
	if (settings.thinking) {
		const values = settings.thinkingValues ?? [];
		// An agent that maps thinking offers its declared levels, so only a
		// listed agent can refuse the one the chain resolved.
		const unlisted = choice.thinking !== "" && !values.some((level) => level === choice.thinking);
		rows.push({
			label: "Thinking",
			key: "thinking",
			kind: "list",
			options: values,
			unfit: unlisted ? "no-level" : undefined,
		});
	} else if (choice.thinking !== "") {
		rows.push({ label: "Thinking", key: "thinking", kind: "text", unfit: "no-setting" });
	}
	// The token row reads the same way as the model row: its agent's
	// capability opens it, and a value the agent cannot take keeps it open so
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
 * The Model row for one agent: the agent's own list with type-ahead, a loading
 * marker while the control plane fetches it, the no-models hint when the agent
 * reports none, and the Text field when its kind reports no list or the fetch
 * failed. The Text field's guide line names the reason the list is gone.
 */
function modelRow(status: ModelListStatus): PanelRow {
	if (status.status === "loading") {
		return { label: "Model", key: "model", kind: "pending", placeholder: LOADING_HINT };
	}
	if (status.status === "available") {
		return {
			label: "Model",
			key: "model",
			kind: "list",
			options: status.models,
			typeAhead: true,
			// A real list carries one long provider in front of many models, so
			// the tail is the part that tells two choices apart.
			clipTail: true,
			// An agent that reports no model has nothing to offer, and an empty
			// value stays the valid unset state.
			placeholder: status.models.length === 0 ? NO_MODELS_HINT : undefined,
		};
	}
	return {
		label: "Model",
		key: "model",
		kind: "text",
		fallbackCause: status.cause,
	};
}

/** One panel row as a marker, a label, and a value or an input. */
function rowElement(
	r: PanelRow,
	value: string,
	selected: boolean,
	geometry: PanelGeometry,
	handleInput: (key: TextKey) => (text: string) => void,
	inputRefs: Record<TextKey, RefObject<InputRenderable | null>>,
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
	if (r.kind === "text") {
		// A text row: a standard single-line input. It owns the caret, the
		// editing keys, and paste, and scrolls horizontally within the value
		// column. The empty field shows the dim placeholder, like the old
		// (empty) hint. A value the agent cannot take wears the warning, so
		// the row shows what the handoff sends and that it will fail on it.
		children.push(
			createElement("input", {
				key: r.key,
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
				ref: inputRefs[r.key as TextKey],
				// A token row refuses a character that is not a digit in the
				// panel's own input handler, which writes the field back without
				// it: OpenTUI offers no before-input hook to hold it out.
				onInput: handleInput(r.key as TextKey),
			}),
		);
		return createElement(
			"box",
			{ key: r.key, style: { flexDirection: "row", height: 1 } },
			...children,
		);
	}
	// A list row, or the row that waits for one. An unset value shows a dim
	// hint, never a blank; a value the current agent cannot run shows the value
	// itself in the warning color, because the handoff would fail on it.
	const unset = value === "";
	// The waiting row is decided before the availability check: it holds no
	// list to compare the value against, so a model the config resolved
	// correctly must not read as a handoff that would fail. The row shows that
	// value in the dim tone the panel uses for a setting it cannot yet confirm.
	const pending = r.kind === "pending";
	const inList = (r.options ?? []).includes(value);
	const text = unset ? (r.placeholder ?? UNSET_HINT) : value;
	const color =
		r.unfit !== undefined || (!pending && !unset && !inList)
			? COLORS.statusWarning
			: unset || pending
				? COLORS.dim
				: selected
					? COLORS.textBright
					: COLORS.text;
	// The tail clip marks a cut-off value with "…", so it belongs to a value
	// alone. A hint that does not fit keeps its front like every other row
	// text, and never carries a marker that claims it is a truncated name.
	const clipValue = r.clipTail === true && !unset;
	children.push(
		createElement(
			"text",
			{ width: geometry.valueWidth, fg: color },
			clipValue
				? truncateTailToWidth(text, geometry.valueWidth)
				: truncateToWidth(text, geometry.valueWidth),
		),
	);
	return createElement(
		"box",
		{ key: r.key, style: { flexDirection: "row", height: 1 } },
		...children,
	);
}
