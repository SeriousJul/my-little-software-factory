/**
 * The plane action registry (ADR 0068): the one home of the names a task type
 * in the action form may name, the settings those names take, and the read
 * that answers whether a task type carries the action form at all. The action
 * form has no template and no profile keys: its settings are the named ones
 * from this registry, never a free string.
 *
 * The registry is its own module because every reader of a task type's form
 * needs it and none of them needs the run: the config validation names the
 * registry's names, the dispatch that claims the item reads its settings, the
 * surfaces name the action from it, and the workflow machine derives a Next
 * step's channel from it. The merge run imports the workflow machine, so a
 * shared module would make those two import each other. The registry holds no
 * command, no source, and no run.
 */

import type { TaskTypeConfig } from "./config.ts";

/** The built-in plane actions, by the name the config's action form may use. */
export const PLANE_ACTION_NAMES = ["merge-pull-request"] as const;
export type PlaneActionName = (typeof PLANE_ACTION_NAMES)[number];

/** The merge methods the merge action runs with, by their config name. */
export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** The method a merge action runs with when its settings name none. */
export const DEFAULT_MERGE_METHOD: MergeMethod = "squash";

/** The name the surfaces give the built-in plane actions. */
export const PLANE_ACTION_LABELS: Readonly<Record<PlaneActionName, string>> = {
	"merge-pull-request": "Merge pull request",
};

/**
 * The word the Shared checkout hold names one plane action's start by (ADR 0109,
 * issue #297 review): the hold's kind, its `<word> waits:` line, its
 * `the <word> of "<ticket>" runs in it` fact, and its `<word> refused:` line all
 * read this one cell. The registry is the only place that can know the word, so
 * the dispatch asks it instead of naming the merge: a second Plane action the
 * registry gains states its own wait in its own words, and the compiler holds the
 * table to one word per name.
 *
 * The word has to read in all four places, the way the labels read on the
 * surfaces.
 */
export const PLANE_ACTION_CHECKOUT_WORDS = {
	"merge-pull-request": "merge",
} as const satisfies Record<PlaneActionName, string>;

/** The checkout word of one plane action, from the registry. */
export type PlaneActionCheckoutWord = (typeof PLANE_ACTION_CHECKOUT_WORDS)[PlaneActionName];

/** The word the Shared checkout hold names one plane action's start by. */
export function planeActionCheckoutWord(name: PlaneActionName): PlaneActionCheckoutWord {
	return PLANE_ACTION_CHECKOUT_WORDS[name];
}

/** The name the surfaces give the named plane action, from the registry. */
export function planeActionLabel(name: PlaneActionName): string {
	return PLANE_ACTION_LABELS[name];
}

/**
 * The named settings of the one plane action: the merge of the ticket's
 * pull request, with the method it runs with. A task type in the action
 * form carries the name in its `action` cell and the method in its
 * `method` cell, and this is the one place that reads the pair back as a
 * setting: an omitted method resolves to the registry's default.
 */
export interface PlaneActionSetting {
	readonly name: PlaneActionName;
	readonly method: MergeMethod;
}

/** Whether the value names a built-in plane action. */
export function isPlaneActionName(value: unknown): value is PlaneActionName {
	return (PLANE_ACTION_NAMES as readonly string[]).includes(value as string);
}

/** Whether the value names a merge method. */
export function isMergeMethod(value: unknown): value is MergeMethod {
	return (MERGE_METHODS as readonly string[]).includes(value as string);
}

/**
 * The plane action of one task type, from its action form; null when the
 * type carries no action form or names an action the registry does not
 * hold. The config validation holds the form to the registry's names, so a
 * caller that reads a validated config gets the settings it runs.
 */
export function planeActionSettingOf(
	taskTypes: Record<string, TaskTypeConfig>,
	taskType: string,
): PlaneActionSetting | null {
	const task = taskTypes[taskType];
	const name = task?.action;
	if (name === undefined || !isPlaneActionName(name)) return null;
	return { name, method: task.method ?? DEFAULT_MERGE_METHOD };
}

/** Whether the task type carries the plane action form. */
export function isPlaneActionTaskType(
	taskTypes: Record<string, TaskTypeConfig>,
	taskType: string,
): boolean {
	return planeActionSettingOf(taskTypes, taskType) !== null;
}
