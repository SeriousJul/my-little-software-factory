/**
 * The repository init's confirmation panel copy (ADR 0075): the one place the
 * confirmed plan becomes the rows the operator reads before the act runs.
 *
 * The plan is the generator's own answer for the repository - the branch the
 * act pushes to, the labels it will create, and each file's treatment - so the
 * panel states what will change, and the act changes only that. This module
 * holds no behavior: it reads the plan and names the rows, the Confirm and
 * Cancel keys the shared action chrome runs.
 */

import type { RepositoryInitPlan } from "../repo-init.ts";
import type { ActionRow } from "./modal-chrome.ts";

/** How the panel names each file treatment, in the operator's words. */
const FILE_ACTION_WORDS: Record<RepositoryInitPlan["files"][number]["action"], string> = {
	new: "will be written",
	unchanged: "is already in place",
	differing: "will be updated",
};

/**
 * The confirmation copy of one confirmed init plan: the title names the
 * repository, the body rows state the branch, the labels, and each file, and
 * the two keys confirm or stand down.
 */
export function repositoryInitPanel(plan: RepositoryInitPlan): {
	title: string;
	bodyLines: string[];
	actions: ActionRow[];
} {
	const lines: string[] = [];
	lines.push(`Pushes to ${plan.targetBranch} with a throwaway worktree.`);
	lines.push("");
	if (plan.labelsToCreate.length === 0) {
		lines.push("Every label is already in place.");
	} else {
		lines.push(
			`Creates ${plan.labelsToCreate.length} label${plan.labelsToCreate.length === 1 ? "" : "s"}:`,
		);
		for (const label of plan.labelsToCreate) lines.push(`  ${label}`);
	}
	lines.push("");
	for (const file of plan.files) {
		lines.push(`${file.path} ${FILE_ACTION_WORDS[file.action]}`);
	}
	const word =
		plan.instructionFileAction === "new"
			? "will be created"
			: plan.instructionFileAction === "unchanged"
				? "is already in place"
				: "will be updated";
	lines.push(`The Agent skills block lands in ${plan.instructionFile} (${word}).`);

	return {
		title: `Init ${plan.repository}`,
		bodyLines: lines,
		actions: [
			{ key: "init", label: "Init", detail: "run the act now" },
			{ key: "cancel", label: "Cancel", detail: "leave the repository as it is" },
		],
	};
}
