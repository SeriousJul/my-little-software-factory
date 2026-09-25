/**
 * The Grouping axis: the one fact that splits a section's list into Groups.
 *
 * The axis is factory state (ADR 0058), so its vocabulary stands in the domain
 * beside the Ticket facts it reads: the durable state file stores one of these
 * values per section, and the shared control library draws the Groups the value
 * names. Which Groups stand collapsed is never here: the folds are session
 * facts, and the state file never holds one.
 *
 * `none` is a value of the axis, not the absence of one: it is the flat list,
 * and the cycle always offers it so the operator can leave grouping with one
 * press.
 */

export const GROUPING_AXES = ["none", "repository", "source", "task", "state", "position"] as const;
export type GroupingAxis = (typeof GROUPING_AXES)[number];

/**
 * The axes that split a list into Groups: every value of the axis but `none`.
 *
 * `none` stays a value of the axis, because the cycle always offers it and the
 * state file stores it. This type is for the reading that only exists once a
 * Group stands on screen: a header's words, or the bar's hint that names the
 * split. It keeps a surface from writing a branch for the flat list no operator
 * can ever be shown.
 */
export type SplitGroupingAxis = Exclude<GroupingAxis, "none">;

/** The axis a fresh state file starts with, and one with no stored row reads as. */
export const DEFAULT_GROUPING_AXIS: GroupingAxis = "none";

/**
 * The sections whose list the plane can group, and so the rows the durable
 * table holds. The Ticket section is the only one today (issue #159); a second
 * list that takes grouping joins this list and needs no new schema version.
 */
export const GROUPED_SECTIONS = ["tickets"] as const;
export type GroupedSection = (typeof GROUPED_SECTIONS)[number];

/**
 * The next axis in the fixed cycle.
 *
 * The cycle order is the operator's promise (user story 4): one press steps to
 * the next split, and the last returns to `none`, so the order is the one the
 * glossary states and never a re-sort of it.
 */
export function nextGroupingAxis(axis: GroupingAxis): GroupingAxis {
	const at = GROUPING_AXES.indexOf(axis);
	return GROUPING_AXES[(at + 1) % GROUPING_AXES.length];
}

/** Whether one string read from the state file names an axis. */
export function isGroupingAxis(value: string): value is GroupingAxis {
	return (GROUPING_AXES as readonly string[]).includes(value);
}
