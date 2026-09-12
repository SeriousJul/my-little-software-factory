/**
 * The override panel: a one-shot change to the settings of a single handoff,
 * made before the handoff starts. It applies to that handoff only and never
 * becomes a new default.
 *
 * It is a centered modal with one row per setting: the agent type, the
 * environment kind, the task type, the model, the thinking level, and the
 * maximum context window. A row shows when its agent maps the setting. It
 * also shows, wearing the warning tone and its written reason, while it
 * carries a value the agent cannot take: hiding it would strand that value
 * where no key can reach it, and the panel must never show anything other
 * than what the handoff sends. The rows
 * start on the settings the resolved task profile names (ADR 0009), so the
 * panel shows what the handoff will run on.
 *
 * The Model row offers the selected agent's Model list (ADR 0010). It is the
 * shared Type-ahead: the row states the Model it stands on, and the line under
 * it holds the search the operator is typing. Each query matches by substring,
 * case-insensitive, and the row names the first value that holds it. The query
 * stays on screen, so a search that matches nothing says so and keeps its text
 * for the operator to correct; it never restarts from its last character, and an
 * unmatched query never becomes the setting. Backspace edits the search, and
 * Delete clears the whole of it.
 *
 * While the control plane fetches the list the row shows a dim loading marker
 * and takes no input. When the agent's kind reports no list, or the fetch
 * failed, the row is the shared Text field, and its guide line names the reason
 * the list is gone. Every field row is the shared field, so the editing keys,
 * the caret, the selection, undo and redo, and paste behave here exactly as they
 * do in the Consultation launcher and the response editor. An input scrolls
 * horizontally within its column and never wraps, so it can never corrupt the
 * rows around it.
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
 * A value that is set but cannot reach the current agent is one Setting fit
 * verdict, read from the module that owns the rule: the row writes the exact
 * sentence the handoff's preflight would answer with, and the warning tone
 * only agrees with what is already written. The sentence names the way out: a
 * row whose agent maps no template for the setting clears with backspace, a
 * listed row that holds a level the agent does not offer cycles or clears, and
 * a context row that holds no count takes digits. A row whose list has not
 * arrived is not judged at all: it holds its value in the dim tone the panel
 * uses for a setting it cannot confirm, and its guide names the wait. A model
 * value wider than the column shows its end, where a real agent list tells its
 * models apart, with a leading marker for the cut; the whole value still rides
 * on the handoff.
 *
 * The keys: up/down and tab/shift+tab move the row selection. j and k move it
 * too, except on a row that takes typing (a Text field, or the Model search),
 * where they type. Left and right move the caret on a field row and on the
 * Model search, and cycle every other list row's value; h and l type on a field
 * row and on the Model search, and cycle every other list row. Switching the task type re-derives the agent, model,
 * thinking, and context rows from the new task type's profile while the
 * operator has not touched each row, so the panel keeps showing the true
 * start values; a row the operator touched keeps its value. Switching the
 * agent never re-derives the model: each setting resolves on its own chain.
 * Enter confirms and hands off. Esc cancels. While the panel is open, the
 * keys of the app below are disabled.
 *
 * The panel sizes itself to the terminal: the value column shrinks first,
 * then the label column, then the marker. The rows scroll within the
 * viewport when the height cannot hold them all: the selected row always
 * stays on screen. A row never wraps or interleaves. The shared Action bar
 * sits at the terminal bottom and names the controls this panel dispatches
 * through the shared control catalogue.
 */

import { createElement, useTerminalDimensions } from "@opentui/react";
import { type ReactElement, type RefObject, useEffect, useRef, useState } from "react";
import type { AgentTypeConfig } from "../config.ts";
import type { EnvironmentKind } from "../domain/ticket.ts";
import type { HandoffChoice } from "../handoff.ts";
import {
	type FitVerdict,
	type ResolvedAgentType,
	settingFit,
	tokenCountDigits,
	type UnfitVerdict,
} from "../setting-fit.ts";
import type { TaskProfileStart } from "../setting-resolution.ts";
import { useControlDispatch } from "./control-dispatch.ts";
import { type ControlContext, contextFor } from "./controls.ts";
import type { MessageFact } from "./messages.ts";
import { MARKER_WIDTH, ModalSurface, modalFrame } from "./modal-chrome.ts";
import { ChoiceRow, cycleChoice } from "./shared/choices.ts";
import { type FieldFacts, type FieldHandle, TextField } from "./shared/fields.ts";
import { useFormSlots } from "./shared/form.ts";
import { controlInk, STATE_WORDS } from "./shared/presentation.ts";
import { type TypeAheadHandle, type TypeAheadMatch, TypeAheadRow } from "./shared/type-ahead.ts";

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

/** The three modes one override panel runs, one per row kind. */
export type OverrideMode = "override-list" | "override-model" | "override-text";
/** The setting one row edits. */
type RowKey = keyof HandoffChoice;
/** The rows whose value the operator can clear to leave the setting to the agent. */
type ClearKey = "model" | "thinking";
/** The rows whose value a text field edits. */
type TextKey = "model" | "thinking" | "contextWindow";
/** The rows a task type switch re-derives from its profile: every setting with a value. */
type DerivedKey = Exclude<RowKey, "environment" | "taskType">;

/**
 * The ways a drafted value cannot reach the Agent it is set on, one per Setting
 * fit cause, so the row can wear the warning the Handoff would fail on.
 */
type UnfitSetting = UnfitVerdict;

interface PanelRow {
	label: string;
	key: RowKey;
	/** "list" cycles, "text" edits, "type-ahead" searches, "pending" waits. */
	kind: "list" | "text" | "type-ahead" | "pending";
	options?: readonly string[];
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
	/**
	 * The configured Agent types, by config name, in the order the Agent row
	 * offers them. The panel reads which settings an Agent maps from the same
	 * record a Handoff and the Setting fit check read, so it holds no second
	 * list of capabilities that can disagree with the start.
	 */
	agents: Readonly<Record<string, AgentTypeConfig>>;
	environments: readonly EnvironmentKind[];
	taskTypes: readonly string[];
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
	/** The base control facts, preserved when this overlay owns input. */
	context: ControlContext;
	/** False while a Key guide or Message view is above this panel. */
	inputActive?: boolean;
	onHelp?: (mode: OverrideMode) => void;
	onMessage?: (mode: OverrideMode) => void;
	/** Reports the catalogue reason for a refused control on the Message line. */
	onUnavailable?: (reason: string) => void;
	/** The Message fact this panel's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
}

/** The desired label column: the widest label plus a gap. */
const LABEL_WIDTH = 12;
/** The desired value column: an agent name, a model, or an env kind. */
const VALUE_WIDTH = 30;
/** The marker column: "❯ " when the row is selected, two spaces otherwise. */
const EMPTY_HINT = "(empty)";
// The cause the empty Model field states, for the two ways its list row is
// gone: a kind that reports no list and a query that failed. Both stay short
// enough to hold in the value column at the smallest pinned panel size.
const FALLBACK_PLACEHOLDERS: Record<ModelListCause, string> = {
	"no-list": "(empty - no model list)",
	"query-failed": "(empty - query failed)",
};
/** The Context row's own refusal words: one count, never a stray character. */
const CONTEXT_REFUSALS = {
	character: "Context window accepts digits only",
	paste: "Context window accepts digits only: the pasted text was refused as a whole",
};
const UNSET_HINT = "(unset)";
const LOADING_HINT = "(loading...)";
const NO_MODELS_HINT = "(no models available)";
/** The panel's columns, within the rows and width the shared chrome leaves. */
interface PanelGeometry {
	markerWidth: number;
	labelWidth: number;
	valueWidth: number;
	/** The cells a row's written note holds: the whole width the box leaves. */
	noteWidth: number;
	maxRows: number;
}

/**
 * The panel's columns at a content width.
 *
 * The value column shrinks first, then the label column, then the marker,
 * and all three keep adding up to the width the box offers. The rows scroll
 * within `maxRows` when the height cannot hold them all; the viewport keeps
 * the selected row on screen, and a row never wraps.
 */
function panelGeometry(contentWidth: number, maxRows: number): PanelGeometry {
	// Reserve one cell for the value before shrinking the marker at the
	// smallest renderable widths.
	const markerWidth = Math.min(MARKER_WIDTH, Math.max(0, contentWidth - 1));
	let labelWidth = 0;
	let valueWidth = 0;
	if (contentWidth > markerWidth) {
		const room = contentWidth - markerWidth;
		// Keep one value cell whenever the panel has room beyond its marker.
		valueWidth = Math.min(VALUE_WIDTH, Math.max(1, room - LABEL_WIDTH));
		labelWidth = Math.min(LABEL_WIDTH, room - valueWidth);
	}
	return {
		markerWidth,
		labelWidth,
		valueWidth,
		// A row's reason is written under it, on the width the box leaves, so a
		// sentence is cut by the panel the operator reads and not by the value
		// column beside it.
		noteWidth: Math.max(0, contentWidth),
		maxRows: Math.max(1, maxRows),
	};
}

/** The rows a full panel offers: agent, environment, task type, model, thinking, context. */
const PANEL_ROW_COUNT = 6;

/**
 * The cells one terminal size gives a row's value.
 *
 * The panel owns its geometry, so a test that checks a clipped value asks the
 * panel how wide the column is instead of mirroring the number by hand. The
 * box is sized the way the panel sizes it: edge to edge, for its full row set.
 */
export function panelValueCells(width: number, height: number): number {
	const frame = modalFrame(width, height, { rows: PANEL_ROW_COUNT, margin: 0 });
	return panelGeometry(frame.contentWidth, frame.contentRows).valueWidth;
}

/**
 * The cells one terminal size gives a row's written note.
 *
 * A note states why a value cannot reach its Agent, so a test that checks how
 * much of a sentence the panel can state asks the panel for the width instead
 * of mirroring the box's arithmetic by hand.
 */
export function panelNoteCells(width: number, height: number): number {
	const frame = modalFrame(width, height, { rows: PANEL_ROW_COUNT, margin: 0 });
	return panelGeometry(frame.contentWidth, frame.contentRows).noteWidth;
}

export function OverridePanel({
	agents,
	environments,
	taskTypes,
	profiles,
	modelList,
	onAgentChange,
	initial,
	onConfirm,
	onCancel,
	context,
	inputActive = true,
	onHelp,
	onMessage,
	onUnavailable,
	message,
	onEmergencyExit,
}: OverridePanelProps) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const ink = controlInk();
	const [choice, setChoice] = useState<HandoffChoice>({ ...initial });
	// The shared form route owns the selected row. Its ref keeps two keys in one
	// renderer tick on the row the first key reached, while its state repaints
	// the viewport around that row.
	const choiceRef = useRef<HandoffChoice>(choice);
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
	// The Model row's visible search. The shared row owns its text; this handle
	// is only how the panel's explicit clear key reaches it.
	const typeAhead = useRef<TypeAheadHandle | null>(null);
	// Each field owns its own handle. The active row chooses which one the Copy
	// control reaches, so another row cannot leave a stale selection on the bar.
	const fields: Record<TextKey, RefObject<FieldHandle | null>> = {
		model: useRef<FieldHandle | null>(null),
		thinking: useRef<FieldHandle | null>(null),
		contextWindow: useRef<FieldHandle | null>(null),
	};
	const searchField = useRef<FieldHandle | null>(null);
	// Whether the field under the cursor holds a selection the Copy control can
	// hand over. The frame reads it, and the field reports it on every change.
	const [hasSelection, setHasSelection] = useState(false);

	const rowsForChoice = (value: HandoffChoice): PanelRow[] =>
		rowsFor(value, agents, environments, taskTypes, listFor(value, modelList));
	const allRows = rowsForChoice(choice);
	const focus = useFormSlots(
		allRows.map((item, index) => ({
			id: `${item.key}-${index}`,
			kind:
				item.kind === "text" || item.kind === "type-ahead"
					? ("field" as const)
					: ("selector" as const),
			label: item.label,
		})),
	);
	const selected = focus.at;
	// The Type-ahead row draws its search under its value, and a row that
	// carries a Setting fit reason draws that sentence under itself, so a row
	// takes the rows it paints. The panel counts them, because a surface is
	// handed no more rows than it holds and a row that overflowed would paint
	// through the row below it.
	const spans = allRows.map((r) => rowCells(r));
	const rowSpan = (index: number): number => spans[index] ?? 1;
	const totalRows = spans.reduce((sum, span) => sum + span, 0);
	// The shared chrome sizes the box: the terminal's rows above the Action
	// bar, or the rows the panel needs, whichever are fewer. The panel spans
	// the terminal edge to edge, so its value column keeps every cell it can.
	const frame = modalFrame(terminalWidth, terminalHeight, {
		rows: totalRows,
		margin: 0,
	});
	const geometry = panelGeometry(frame.contentWidth, frame.contentRows);
	// Switching the agent can hide the rows below the selection; clamp it.
	const safeSelected = Math.min(selected, allRows.length - 1);
	// The rows the terminal height holds, scrolled to keep the selected row on
	// screen. A short terminal scrolls the viewport; a row never wraps, and a
	// two-row row is moved whole.
	const startAt = (index: number): number =>
		spans.slice(0, index).reduce((sum, span) => sum + span, 0);
	// The first row the viewport shows: the earliest one that still leaves the
	// selected row wholly inside the rows the terminal holds.
	let start = 0;
	while (
		start < safeSelected &&
		startAt(safeSelected) - startAt(start) + rowSpan(safeSelected) > geometry.maxRows
	) {
		start += 1;
	}
	let used = 0;
	let end = start;
	while (end < allRows.length && used + rowSpan(end) <= geometry.maxRows) {
		used += rowSpan(end);
		end += 1;
	}
	const rows = allRows.slice(start, Math.max(start + 1, end));
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
		return all[Math.min(focus.index(), all.length - 1)];
	};
	const activeField = (): FieldHandle | null => {
		const target = cursorRow();
		if (target.kind === "type-ahead") return searchField.current;
		if (target.kind === "text") return fields[target.key as TextKey]?.current ?? null;
		return null;
	};
	// A selection belongs to the focused field only. Re-read it after the shared
	// route moves focus so an old selection cannot keep F3 on the Action bar.
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeField is derived from the focused row and stable refs
	useEffect(() => {
		setHasSelection(activeField()?.hasSelection() === true);
	}, [focus.at]);
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
		if (target.kind !== "list" || target.options === undefined) return;
		const next = cycleChoice(target.options, choiceRef.current[target.key], delta);
		if (next === undefined) return;
		if (target.key !== "environment" && target.key !== "taskType") touch(target.key);
		commit((current) =>
			target.key === "taskType" ? reDerive(current, next) : { ...current, [target.key]: next },
		);
	};
	/** Record that the operator set one of the rows a task type switch re-derives. */
	const touch = (key: DerivedKey) => {
		touchedRef.current[key] = true;
	};
	/** Backspace or Delete on a list row: leave that setting to the agent. */
	const clearRow = () => {
		const target = cursorRow();
		// A field row and the Model search own their own deletion keys, so this
		// handler never sees them, and the pending row holds no value to clear.
		if (target.kind !== "list") return;
		if (target.key !== "model" && target.key !== "thinking") return;
		const key: ClearKey = target.key;
		touch(key);
		commit((current) => (current[key] === "" ? current : { ...current, [key]: "" }));
	};
	/** Delete on the Model search: clear the whole query, or the value it named. */
	const clearSearch = () => {
		if (typeAhead.current === null) return;
		if (typeAhead.current.query() !== "") {
			typeAhead.current.clear();
			setHasSelection(false);
			return;
		}
		// With no query left to remove, the same key gives the Model back to the
		// agent, which is what clearing a list row has always done.
		touch("model");
		commit((current) => (current.model === "" ? current : { ...current, model: "" }));
	};
	/** One shared field's change: mirror the value into the panel's choice. */
	const fieldChanged = (key: TextKey) => (facts: FieldFacts) => {
		if (choiceRef.current[key] === facts.value) return;
		touch(key);
		commit((current) => ({ ...current, [key]: facts.value }));
	};
	/** One Type-ahead search's change: the value follows the first match. */
	const searchChanged = (_query: string, match: TypeAheadMatch, facts: FieldFacts) => {
		setHasSelection(facts.selection !== "");
		if (match.first === undefined || choiceRef.current.model === match.first) return;
		touch("model");
		commit((current) => ({ ...current, model: match.first as string }));
	};
	// The panel's mode follows the row the cursor is on, so it is read at key
	// time: one key can move the cursor, and the next belongs to the new row.
	const currentMode = (): OverrideMode => {
		const target = cursorRow();
		if (target.kind === "text") return "override-text";
		if (target.kind === "type-ahead") return "override-model";
		return "override-list";
	};
	// The facts the catalogue gates on, stated by the row the cursor is on. The
	// Copy control needs the field's own selection, and the clear control needs
	// to know whether the Model search holds anything to clear.
	const panelContext = (mode: OverrideMode) =>
		contextFor(mode, {
			...context,
			fieldHasSelection: hasSelection,
			formSearchActive: typeAhead.current?.query() !== "",
		});
	useControlDispatch({
		mode: currentMode,
		// The Copy and Clear controls are gated on facts only this panel knows,
		// so the panel states them and the catalogue decides.
		context: panelContext(currentMode()),
		active: inputActive,
		// The Ctrl combos the catalogue does not name (undo, redo, word
		// movement and word delete) belong to the focused field. Ctrl+C stays
		// the emergency exit whatever a field holds.
		skip: (key) => key.ctrl === true && key.name !== "c",
		onUnavailable,
		onEmergencyExit,
		handlers: {
			"move-list": ({ key }) => {
				// The shared form route owns Tab and row movement. A selection is
				// only current while its field still owns the focus.
				focus.move(
					key.name === "up" || key.name === "k" || (key.name === "tab" && key.shift) ? -1 : 1,
				);
				setHasSelection(false);
				key.preventDefault?.();
			},
			"change-override": ({ key }) => {
				cycle(key.name === "left" || key.name === "h" ? -1 : 1);
				key.preventDefault?.();
			},
			handoff: ({ key }) => {
				onConfirm(choiceRef.current);
				key.preventDefault?.();
			},
			"clear-override": ({ key }) => {
				clearRow();
				key.preventDefault?.();
			},
			"clear-search": ({ key }) => {
				clearSearch();
				// The search field would otherwise delete a character with the same
				// key that clears the whole query.
				key.preventDefault?.();
			},
			"copy-selection": ({ key }) => {
				const result = activeField()?.copySelection();
				onUnavailable?.(result?.reason ?? "The panel holds no field to copy from");
				key.preventDefault?.();
			},
			cancel: ({ key }) => {
				onCancel();
				key.preventDefault?.();
			},
			help: () => onHelp?.(currentMode()),
			message: () => onMessage?.(currentMode()),
		},
	});
	const mode = currentMode();
	return createElement(ModalSurface, {
		frame,
		width: terminalWidth,
		title: "Override",
		borderColor: ink.indicator.fg ?? undefined,
		// One row is enough to be a panel: the rows that do not fit scroll.
		minContentRows: 1,
		message,
		bar: { mode, context: panelContext(mode) },
		children: rows.map((r) =>
			rowElement(
				r,
				choice[r.key],
				r.key === row.key,
				geometry,
				inputActive,
				fieldChanged,
				searchChanged,
				typeAhead,
				fields,
				searchField,
				setHasSelection,
			),
		),
	});
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

/** The rows one panel row paints: its value, its search, and its reason. */
function rowCells(row: PanelRow): number {
	return (row.kind === "type-ahead" ? 2 : 1) + (row.unfit === undefined ? 0 : 1);
}

/** The rows the panel offers for the current choice, in order. */
function rowsFor(
	choice: HandoffChoice,
	agents: Readonly<Record<string, AgentTypeConfig>>,
	environments: readonly string[],
	taskTypes: readonly string[],
	modelStatus: ModelListStatus,
): PanelRow[] {
	// An Agent type the config no longer names reads as one that maps nothing:
	// every value the choice carries then shows in its warning row, where the
	// operator can clear it.
	const agent: ResolvedAgentType = {
		agentType: choice.agentType,
		agent: agents[choice.agentType] ?? { kind: choice.agentType },
	};
	const staticVerdicts = settingFit.staticFit(agent, choice);
	// A fetched list is the only fact beyond static fit. A loading or an
	// unavailable list leaves the static Model verdict in place: a list that
	// cannot be fetched skips the Model list question, just as a handoff does.
	const modelVerdict =
		modelStatus.status === "available"
			? settingFit.modelInList(agent, choice.model, modelStatus.models)
			: staticVerdicts.model;
	const rows: PanelRow[] = [
		{ label: "Agent", key: "agentType", kind: "list", options: Object.keys(agents) },
		{ label: "Environment", key: "environment", kind: "list", options: environments },
		{ label: "Task type", key: "taskType", kind: "list", options: taskTypes },
	];
	// A row shows when its Agent maps the setting. It also shows, wearing the
	// warning the shared verdict gives, while it carries a value the Agent
	// cannot take: hiding it would strand that value where no key can reach it,
	// and the panel must never show something other than what the handoff sends.
	if (agent.agent.model !== undefined) {
		rows.push(modelRow(modelStatus, modelVerdict));
	} else if (choice.model !== "") {
		rows.push({ label: "Model", key: "model", kind: "text", unfit: unfitVerdict(modelVerdict) });
	}
	if (agent.agent.thinking !== undefined) {
		rows.push({
			label: "Thinking",
			key: "thinking",
			kind: "list",
			options: agent.agent.thinkingValues ?? [],
			unfit: unfitVerdict(staticVerdicts.thinking),
		});
	} else if (choice.thinking !== "") {
		rows.push({
			label: "Thinking",
			key: "thinking",
			kind: "text",
			unfit: unfitVerdict(staticVerdicts.thinking),
		});
	}
	// The token row reads the same way as the model row: its Agent's
	// capability opens it, and a value the Agent cannot take keeps it open so
	// the operator can clear it.
	if (agent.agent.contextWindow !== undefined || choice.contextWindow !== "") {
		rows.push({
			label: "Context",
			key: "contextWindow",
			kind: "text",
			digits: true,
			unfit: unfitVerdict(staticVerdicts.contextWindow),
		});
	}
	return rows;
}

/** The failing verdict a row carries, or nothing when the value fits. */
function unfitVerdict(verdict: FitVerdict): UnfitVerdict | undefined {
	return verdict.ok ? undefined : verdict;
}

/**
 * The Model row for one agent: the agent's own list with type-ahead, a loading
 * marker while the control plane fetches it, the no-models hint when the agent
 * reports none, and the Text field when its kind reports no list or the fetch
 * failed. The Text field's placeholder names the reason the list is gone, and
 * every branch carries the shared fit verdict for the value on the row.
 */
function modelRow(status: ModelListStatus, verdict: FitVerdict): PanelRow {
	const unfit = unfitVerdict(verdict);
	if (status.status === "loading") {
		return { label: "Model", key: "model", kind: "pending", placeholder: LOADING_HINT, unfit };
	}
	if (status.status === "available") {
		return {
			label: "Model",
			key: "model",
			kind: "type-ahead",
			options: status.models,
			// An agent that reports no model has nothing to offer, and an empty
			// value stays the valid unset state the panel names.
			placeholder: status.models.length === 0 ? NO_MODELS_HINT : UNSET_HINT,
			unfit,
		};
	}
	return {
		label: "Model",
		key: "model",
		kind: "text",
		fallbackCause: status.cause,
		unfit,
	};
}

/**
 * One row of the panel, drawn by the module that owns its behavior.
 *
 * A field row is the shared Text field, so its caret, selection, undo history,
 * and paste rules are the rules every other surface has. The Model row over a
 * list the agent reported is the shared Type-ahead, so the search the operator
 * typed is on screen beside the value it names. A list row that takes no typing
 * is the shared selector row: it states its own value, its unset word, and the
 * written reason of a value the Agent cannot take.
 */
function rowElement(
	r: PanelRow,
	value: string,
	selected: boolean,
	geometry: PanelGeometry,
	inputActive: boolean,
	fieldChanged: (key: TextKey) => (facts: FieldFacts) => void,
	searchChanged: (query: string, match: TypeAheadMatch, facts: FieldFacts) => void,
	typeAhead: RefObject<TypeAheadHandle | null>,
	fields: Record<TextKey, RefObject<FieldHandle | null>>,
	searchField: RefObject<FieldHandle | null>,
	reportSelection: (has: boolean) => void,
): ReactElement {
	if (r.kind === "text") {
		return createElement(TextField, {
			key: r.key,
			label: r.label,
			value,
			focused: selected && inputActive,
			inputActive,
			width: geometry.valueWidth,
			labelWidth: geometry.labelWidth,
			digits: r.digits === true,
			// A count keeps one spelling: the row folds a leading zero the same
			// way the config parser does, so what the panel shows is the count the
			// agent gets. The field owns the caret through the fold.
			normalize: r.digits === true ? tokenCountDigits : undefined,
			placeholder:
				r.fallbackCause === undefined ? EMPTY_HINT : FALLBACK_PLACEHOLDERS[r.fallbackCause],
			// A value the target cannot take is the field's own news: the shared
			// field writes the exact sentence the start will answer with, and the
			// warning tone only agrees with it.
			error: r.unfit?.reason ?? null,
			noteWidth: geometry.noteWidth,
			fieldRef: fields[r.key as TextKey],
			refusals: CONTEXT_REFUSALS,
			onValueChange: (facts) => {
				fieldChanged(r.key as TextKey)(facts);
				reportSelection(selected && facts.selection !== "");
			},
		});
	}
	if (r.kind === "type-ahead") {
		return createElement(TypeAheadRow, {
			key: r.key,
			label: r.label,
			value,
			options: r.options ?? [],
			focused: selected && inputActive,
			inputActive,
			width: geometry.valueWidth,
			labelWidth: geometry.labelWidth,
			placeholder: r.placeholder ?? STATE_WORDS.unset,
			// The shared verdict owns whether the Model reaches the Agent, so an
			// empty value is fit even when the runtime reports no Models, and the
			// row writes the sentence the Handoff would answer with.
			warning: r.unfit !== undefined,
			error: r.unfit?.reason ?? null,
			noteWidth: geometry.noteWidth,
			typeAheadRef: typeAhead,
			fieldRef: searchField,
			onQueryChange: (query, match, facts) => {
				searchChanged(query, match, facts);
				reportSelection(selected && facts.selection !== "");
			},
		});
	}
	// A list row, or the row that waits for a list, is the shared selector row:
	// its marker, its tones, its unset word, and the written reason of a value
	// the Agent cannot take are the ones every other form row uses.
	return createElement(ChoiceRow, {
		key: r.key,
		label: r.label,
		value,
		focused: selected,
		width: geometry.valueWidth,
		labelWidth: geometry.labelWidth,
		placeholder: r.placeholder ?? UNSET_HINT,
		// The waiting row is decided before the availability check: it holds no
		// list to compare the value against, so a model the config resolved
		// correctly must not read as a handoff that would fail. The row shows
		// that value in the tone the panel uses for a setting it cannot confirm.
		pending: r.kind === "pending" && value !== "",
		warning: r.unfit !== undefined,
		error: r.unfit?.reason ?? null,
		noteWidth: geometry.noteWidth,
	});
}
