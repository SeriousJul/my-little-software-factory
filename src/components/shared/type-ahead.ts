/**
 * The shared Type-ahead: a visible, editable substring search of a list.
 *
 * The row states the value it stands on, and below it the search the operator
 * is typing. The two stay distinct: a query that matches nothing is retained on
 * screen with that stated, and it never becomes the setting. Backspace and the
 * caret keys edit the query, one explicit key clears the whole of it, and the
 * surface's own rules decide which values the list offers and which of them are
 * valid.
 *
 * The search text is the module's own editing state, because it is editing
 * state: a surface never repairs it, and a fix to the caret or to paste reaches
 * every row that uses this module.
 */
import { createElement } from "@opentui/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";
import { ChoiceRow } from "./choices.ts";
import { type FieldFacts, type FieldHandle, TextField } from "./fields.ts";
import { controlInk, MARKER_WIDTH, STATE_WORDS } from "./presentation.ts";

/** The search's own label: the row above it already names the value. */
const SEARCH_LABEL = "Search";
/** The cells the no-match word holds beside the search. */
const NO_MATCH_CELLS = 11;

/** What one query answers about a list. */
export interface TypeAheadMatch {
	/** How many values hold the query. */
	count: number;
	/** The first value that holds it, or undefined when none does. */
	first?: string;
}

/**
 * The values one query matches, by substring, case-insensitive.
 *
 * Containment of the whole query, never a fuzzy run: the search text stays on
 * screen while it matches, so what the operator reads is what the query holds.
 */
export function typeAheadMatch(options: readonly string[], query: string): TypeAheadMatch {
	if (query === "") return { count: options.length };
	const needle = query.toLowerCase();
	const matching = options.filter((option) => option.toLowerCase().includes(needle));
	return { count: matching.length, first: matching[0] };
}

/** What a surface can ask a search row to do. */
export interface TypeAheadHandle {
	/** Remove the whole query, leaving the selected value where it stands. */
	clear(): void;
	/** The query as the operator has it now. */
	query(): string;
}

export interface TypeAheadRowProps {
	/** The name of the value the row stands on. */
	label: string;
	/** The selected value. It stays distinct from the query. */
	value: string;
	/** The list the search reads. */
	options: readonly string[];
	focused: boolean;
	width: number;
	labelWidth: number;
	/** The written word that states why the row holds no value. */
	placeholder?: string;
	/** Whether the value the row stands on cannot reach its target. */
	warning?: boolean;
	/** Why the value the row stands on cannot reach its target, in words. */
	error?: string | null;
	/** The cells the value row's written note may use. Defaults to its own. */
	noteWidth?: number;
	/** False while a surface above this row owns the keys. Default: true. */
	inputActive?: boolean;
	/** The handle a surface uses for the explicit clear and the row's query. */
	typeAheadRef?: { current: TypeAheadHandle | null };
	/** The field handle for selection and Copy selection. */
	fieldRef?: { current: FieldHandle | null };
	/** Every change of the search text, match, caret, and selection. */
	onQueryChange?: (query: string, match: TypeAheadMatch, facts: FieldFacts) => void;
}

/** The shared Type-ahead row: the value, and the editable search under it. */
export function TypeAheadRow(props: TypeAheadRowProps): ReactElement {
	const [query, setQuery] = useState("");
	const queryRef = useRef("");
	if (props.typeAheadRef !== undefined) {
		props.typeAheadRef.current = {
			query: () => queryRef.current,
			clear: () => {
				queryRef.current = "";
				setQuery("");
			},
		};
	}
	const noMatch = query !== "" && typeAheadMatch(props.options, query).count === 0;
	return createElement(
		"box",
		{ key: props.label, style: { flexDirection: "column" } },
		createElement(ChoiceRow, {
			label: props.label,
			value: props.value,
			focused: props.focused,
			width: props.width,
			labelWidth: props.labelWidth,
			placeholder: props.placeholder,
			warning: props.warning === true,
			error: props.error,
			noteWidth: props.noteWidth,
			// A model list tells its members apart at their end, so the row keeps
			// the tail of a value wider than its column.
			clipTail: true,
		}),
		createElement(
			"box",
			{ key: "search", style: { flexDirection: "row", height: 1 } },
			createElement(TextField, {
				label: SEARCH_LABEL,
				value: query,
				focused: props.focused && props.inputActive !== false,
				inputActive: props.inputActive,
				// The no-match word holds its own cells only while it is the news, so
				// a query the operator is reading is never cut to make room for a word
				// that says nothing.
				width: Math.max(1, props.width - (noMatch ? NO_MATCH_CELLS : 0)),
				labelWidth: props.labelWidth - MARKER_WIDTH,
				marked: false,
				fieldRef: props.fieldRef,
				onValueChange: (facts) => {
					queryRef.current = facts.value;
					setQuery(facts.value);
					props.onQueryChange?.(facts.value, typeAheadMatch(props.options, facts.value), facts);
				},
			}),
			noMatch
				? createElement("text", { fg: controlInk().error.fg ?? undefined }, STATE_WORDS.noMatch)
				: null,
		),
	);
}
