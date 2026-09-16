/**
 * The one-shot config migration to the workflow machine (ADR 0027).
 *
 * A config that carries the pre-machine keys (`task-rules`, `workflows`)
 * is rewritten at load: rules become states, expressible edges become
 * task-type transitions, the four seed templates are replaced on exact
 * match (a customized template is left untouched and named in the report),
 * inexpressible edges are dropped and each named in the operator-readable
 * report, and the old file is backed up. The migration is pure here: it
 * returns the new text and the report, and the caller validates the new
 * text before it writes anything.
 */
import { parse, stringify } from "smol-toml";

/** A migration that cannot express the input. The caller stops the load. */
export class ConfigMigrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigMigrationError";
	}
}

/** The one migration result: the new config text and the operator report. */
export interface ConfigMigrationResult {
	configText: string;
	reportText: string;
	/** The backup file name, next to the config. */
	backupFileName: string;
	/** The migration report file name, next to the config. */
	reportFileName: string;
}

/** Whether the parsed config carries a pre-workflow-machine key (ADR 0027). */
export function hasOldWorkflowMachineKeys(data: unknown): boolean {
	return isRecord(data) && ("task-rules" in data || "workflows" in data);
}

/**
 * Migrate a pre-workflow-machine config to the machine. Pure: the result's
 * config text is validated by the caller before the migration writes.
 *
 * @param configPath the config file path, for the report and file names.
 * @param originalData the parsed pre-machine config table.
 * @param shippedDefaultText the Default configuration the package ships.
 * @param date the migration date, ISO `YYYY-MM-DD`, for the report.
 */
export function migrateWorkflowMachineConfig(
	configPath: string,
	originalData: Record<string, unknown>,
	shippedDefaultText: string,
	date: string = new Date().toISOString().slice(0, 10),
): ConfigMigrationResult {
	const baseName = configPath.split(/[\\/]/).pop() ?? "config.toml";
	const backupFileName = `${baseName}.bak`;
	const reportFileName = `${baseName}.migration-report.md`;

	const rules = tableList(originalData["task-rules"], "task-rules");
	const edges = tableList(originalData["workflows"], "workflows");
	const shipped = parse(shippedDefaultText) as Record<string, unknown>;
	const shippedTaskTypes = isRecord(shipped["task-types"]) ? shipped["task-types"] : {};
	const taskTypes = isRecord(originalData["task-types"]) ? originalData["task-types"] : {};

	// One state per rule: the state is named for the rule's task type, and
	// its match is the rule's when table, carried over verbatim.
	const states: Record<string, unknown>[] = [];
	const stateNames = new Set<string>();
	const stateForTask = new Map<string, { name: string; match: Record<string, unknown> }>();
	const stateLines: string[] = [];
	for (const rule of rules) {
		const taskType = rule["task-type"];
		if (typeof taskType !== "string" || taskType === "") {
			throw new ConfigMigrationError("a [[task-rules]] entry has no task-type string");
		}
		const match = isRecord(rule.when) ? rule.when : {};
		let name = taskType;
		for (let suffix = 2; stateNames.has(name); suffix++) name = `${taskType}-${suffix}`;
		stateNames.add(name);
		stateForTask.set(taskType, { name, match });
		states.push({ name, "task-type": taskType, match: { ...match } });
		stateLines.push(`- \`${name}\`: task \`${taskType}\`, matches ${matchDescription(match)}.`);
	}

	// One transition per expressible edge: the single edge out of a task
	// type whose target one state suggests. The transition writes that
	// state's label facts, on the surface the state names, and it carries
	// the edge's pins.
	const transitions = new Map<string, { transition: Record<string, unknown>; line: string }>();
	const droppedEdges: string[] = [];
	for (const [taskType, rawTask] of Object.entries(taskTypes)) {
		if (!isRecord(rawTask)) continue;
		const fromEdges = edges.filter((edge) => edge["from"] === taskType);
		if (fromEdges.length === 0) continue;
		if (fromEdges.length > 1) {
			droppedEdges.push(
				`the ${fromEdges.length} outgoing edges from \`${taskType}\`: a transition has one, and the edges offered a choice the machine's transitions do not express. Route them by hand from the decision modal.`,
			);
			continue;
		}
		const edge = fromEdges[0];
		const targets = Array.isArray(edge["to"]) ? (edge["to"] as unknown[]) : [];
		if (targets.length !== 1 || typeof targets[0] !== "string" || targets[0] === "") {
			droppedEdges.push(
				`the edge from \`${taskType}\` to ${targetList(targets)}: a transition's single edge must name exactly one task type.`,
			);
			continue;
		}
		const target = targets[0] as string;
		const state = stateForTask.get(target);
		if (state === undefined) {
			droppedEdges.push(
				`the edge from \`${taskType}\` to \`${target}\`: no state suggests \`${target}\`, so the transition has no facts to write.`,
			);
			continue;
		}
		const facts = [...stringList(state.match["labels-all"]), ...stringList(state.match["labels-any"])];
		if (facts.length === 0) {
			droppedEdges.push(
				`the edge from \`${taskType}\` to \`${target}\`: the state \`${state.name}\` matches without naming any labels, so it has no facts to write.`,
			);
			continue;
		}
		const onPullRequest = state.match["source-kind"] === "github-pull-request";
		const transition: Record<string, unknown> = { "ticket-facts": [], "pull-request-facts": [] };
		if (onPullRequest) transition["pull-request-facts"] = facts;
		else transition["ticket-facts"] = facts;
		if (typeof edge["agent"] === "string") transition["agent"] = edge["agent"];
		if (typeof edge["environment"] === "string") transition["environment"] = edge["environment"];
		transitions.set(taskType, {
			transition,
			line: `\`${taskType}\`: writes the ${onPullRequest ? "pull request" : "ticket"} facts ${labelList(facts)} (from the edge to \`${target}\` and the state \`${state.name}\`).`,
		});
	}

	// Task types: auto-close is dropped (named), and a seed template that
	// matches the pre-machine seed exactly is replaced by the clean one.
	const newTaskTypes: Record<string, unknown> = {};
	const templateLines: string[] = [];
	const autoCloseLines: string[] = [];
	for (const [name, rawTask] of Object.entries(taskTypes)) {
		if (!isRecord(rawTask)) {
			newTaskTypes[name] = rawTask;
			continue;
		}
		const task: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(rawTask)) {
			if (key === "auto-close") {
				if (value === true) {
					autoCloseLines.push(
						`\`auto-close = true\` on \`${name}\`: dropped. The replacement is \`auto-advance\` on \`${name}\`'s transition.`,
					);
				}
				continue;
			}
			if (key === "template" && typeof value === "string") {
				const replacement = seedTemplateReplacement(name, value, shippedTaskTypes);
				task.template = replacement.template;
				if (OLD_SEED_TEMPLATES[name] !== undefined) {
					templateLines.push(
						replacement.replaced
							? `\`${name}\`: replaced with the clean seed template (the pre-migration template matched the seed exactly).`
						: `\`${name}\`: left untouched (the template does not match the pre-migration seed).`,
					);
				}
				continue;
			}
			task[key] = value;
		}
		const transition = transitions.get(name);
		if (transition !== undefined) task.transition = transition.transition;
		newTaskTypes[name] = task;
	}

	// Reassemble with the old key order: states take the task-rules
	// position, task-types keeps its own, and the old keys are gone.
	const newData: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(originalData)) {
		if (key === "task-rules") {
			newData.states = states;
			continue;
		}
		if (key === "workflows") continue;
		if (key === "task-types") {
			newData["task-types"] = newTaskTypes;
			continue;
		}
		newData[key] = value;
	}
	if (newData.states === undefined) newData.states = states;
	if (newData["task-types"] === undefined) newData["task-types"] = newTaskTypes;

	const configText = [
		`# Migrated to the workflow machine on ${date} (ADR 0027).`,
		`# The pre-migration file is at ${backupFileName}; the migration report at ${reportFileName}.`,
		"# The plane owns the workflow labels: states name the machine's states,",
		"# and each task type's transition writes the label facts its",
		"# completed turns leave behind.",
		"",
		stringify(newData),
	].join("\n");

	const reportText = [
		"# Workflow machine migration",
		"",
		`The config at \`${configPath}\` carried the pre-workflow-machine keys. The`,
		`control plane rewrote it at load on ${date} (ADR 0027). The pre-migration`,
		`file is at \`${backupFileName}\`, next to the config.`,
		"",
		"## States",
		"",
		"Rules became states: one state per rule, named for the rule's task type,",
		"with the rule's match carried over.",
		"",
		...(stateLines.length > 0 ? stateLines : ["No task rules: no states were derived."]),
		"",
		"## Transitions",
		"",
		"Expressible edges became transitions: the transition writes the state",
		"label facts of the edge's single target, on the surface the state",
		"names, and carries the edge's agent and environment pins.",
		"",
		...(transitions.size > 0
			? [...transitions.values()].map((entry) => `- ${entry.line}`)
			: ["No edges were expressible as transitions."]),
		...(droppedEdges.length > 0
			? ["", "Dropped edges, named:", "", ...droppedEdges.map((line) => `- ${line}`)]
			: []),
		"",
		"## Templates",
		"",
		"The four seed templates are replaced on exact match; a customized",
		"template is left untouched.",
		"",
		...(templateLines.length > 0 ? templateLines : ["No seed task types: no template actions."]),
		"",
		"## Dropped keys",
		"",
		...(autoCloseLines.length > 0 ? autoCloseLines : ["No `auto-close` flags were set."]),
		"",
	].join("\n");

	return { configText, reportText, backupFileName, reportFileName };
}

/**
 * The exact pre-machine seed templates. A task type whose template matches
 * its seed exactly is replaced by the clean one from the shipped Default
 * configuration; anything else is left untouched.
 */
const OLD_SEED_TEMPLATES: Record<string, string> = {
	implement: `Implement the following {source-kind}. 

### Instructions

1. **Develop Code**
   - Implement all acceptance criteria on this branch.
   - Commit all changes to this branch.

2. **Create Pull Request**
   - Open a new Pull Request.
   - Link the pull request to the ticket. Successfully merging this pull request may close these issues.
   - List any technical choices made when specifications were not clear.
   - Add the **\`ready-for-review\`** label to the pull request.
   - Never add the **\`ready-to-ship\`** or **\`needs-work\`** labels to the pull request. Only the review task sets those.

3. **Update Ticket**
   - Remove the **\`ready-for-agent\`** label from the ticket.

Repository: {repository}

{external-key}: {title}

URL: {source-url}

Labels: {labels}

Description:
{description}`,
	review: `Review pull request {external-key}: {title}.

### Rules
1. **Verify Specification**
   - Check if the code satisfies all acceptance criteria in the ticket.
   - List missing requirements or incorrect behavior.

2. **Assess Code Quality**
   - Check design, modularity, readability, and testing standards.
   - List maintainability, security, or performance issues.

3. **Calculate Score**
   - Give a total score from 0 to 100 based on both areas.

### Output Format

- **Score:** [0-100] / 100
- **Specification Check:** [Pass/Fail - Details]
- **Quality Check:** [Pass/Fail - Details]
- **Required Changes:** [Bullet points]

### Outcome
- Post the output as a comment on the pull request.
- Remove label 'ready-for-review'.
- Set label to **\`ready-to-ship\`** if score is 90 or higher.
- Set label to **\`needs-work\`** if score is less than 90.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}`,
	rework: `Rework pull request {external-key}: {title}.

### Instructions

1. **Read Comments**
   - Read last review comments.

2. **Make Changes**
   - Correct the code according to the review comments.

3. **Update Repository**
   - Commit and push changes to this branch.

4. **Update Pull Request**
   - Write a summary of your changes in a new comment.
   - Remove the **\`needs-work\`** label.
   - Add the **\`ready-for-review\`** label.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}`,
	merge: `Merge pull request {external-key}: {title}.

### Instructions

1. **Squash and Merge**
   - Squash and merge the pull request into its base branch.

2. **On a Blocked Merge**
   - If the pull request has a merge conflict or a failing CI check, do not merge.
   - Remove the **\`ready-to-ship\`** label.
   - Add the **\`needs-work\`** label.
   - Post a comment explaining the reason for the blocked merge.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}`,
};

/**
 * Replace a seed template on exact match. The replacement comes from the
 * shipped Default configuration, so the migration always lands the clean
 * templates the machine ships.
 */
function seedTemplateReplacement(
	name: string,
	template: string,
	shippedTaskTypes: Record<string, unknown>,
): { template: string; replaced: boolean } {
	const oldSeed = OLD_SEED_TEMPLATES[name];
	if (oldSeed === undefined || template !== oldSeed) return { template, replaced: false };
	const shippedTask = shippedTaskTypes[name];
	if (isRecord(shippedTask) && typeof shippedTask.template === "string") {
		return { template: shippedTask.template, replaced: true };
	}
	return { template, replaced: false };
}

/** A config table's list-valued key, as a list of tables. */
function tableList(value: unknown, where: string): Record<string, unknown>[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new ConfigMigrationError(`${where} is not a list`);
	return value.map((item, index) => {
		if (!isRecord(item)) throw new ConfigMigrationError(`${where}[${index}] is not a table`);
		return item;
	});
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function targetList(targets: unknown[]): string {
	return targets.map((target) => `\`${String(target)}\``).join(", ") || "nothing";
}

function labelList(labels: string[]): string {
	return labels.map((label) => `\`${label}\``).join(", ");
}

/** The report's one-line description of a state's match. */
function matchDescription(match: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const key of [
		"source-name",
		"source-kind",
		"repository",
		"labels-all",
		"labels-any",
		"labels-none",
	] as const) {
		const value = match[key];
		if (typeof value === "string") parts.push(`${key} \`${value}\``);
		else if (Array.isArray(value)) parts.push(`${key} ${value.map((item) => `\`${String(item)}\``).join(", ")}`);
	}
	return parts.length > 0 ? parts.join(", ") : "everything (a catch-all)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
