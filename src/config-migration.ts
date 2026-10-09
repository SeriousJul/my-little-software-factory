/**
 * The one-shot config migration to the workflow machine (ADR 0027).
 *
 * A config that carries the pre-machine keys (`task-rules`, `workflows`)
 * is rewritten at load: rules become states, expressible edges become
 * task-type transitions, the four seed templates are replaced on exact
 * match (a customized template is left untouched and named in the report),
 * inexpressible edges are dropped and each named in the operator-readable
 * report, and the old file is backed up. A task type whose seed template was
 * replaced and whose own config expressed no edge takes the shipped seed's
 * transition: dropping the template's label prose and writing no label would
 * otherwise stop the workflow. The migration is pure here: it returns the new
 * text and the report, and the caller validates the new text before it writes
 * anything.
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
	/** The load's note line: what the migration did, in the operator's words. */
	noteText: string;
}

/**
 * Whether the parsed config carries a pre-workflow-machine key (ADR 0027).
 *
 * `auto-close` counts too: a config that carries only that flag on a task
 * type is still pre-machine, and the strict loader would otherwise reject it
 * with an error that names a backup the migration never made.
 */
export function hasOldWorkflowMachineKeys(data: unknown): boolean {
	if (!isRecord(data)) return false;
	if ("task-rules" in data || "workflows" in data) return true;
	// The retired Priority table (ADR 0050) rides the same migration: a file
	// that carries it alone is still a file the strict loader would refuse,
	// and the load migrates it the way it migrates the machine keys.
	if ("priority" in data) return true;
	const taskTypes = data["task-types"];
	if (!isRecord(taskTypes)) return false;
	for (const task of Object.values(taskTypes)) {
		if (isRecord(task) && ("auto-close" in task || oldMergeSeedMatch(task))) return true;
	}
	return false;
}

/**
 * Whether the task type carries the pre-action merge seed template exactly
 * (ADR 0068). A merge type in the prompt form whose template matches the
 * shipped seed exactly is the seed the plane shipped, and the load takes the
 * action form it was replaced by, the way the seed templates migrate.
 */
function oldMergeSeedMatch(task: Record<string, unknown>): boolean {
	return task.template === OLD_SEED_TEMPLATES.merge || task.template === MERGE_PROMPT_SEED_TEMPLATE;
}

/**
 * The shipped machine-era merge seed template, beside the pre-machine one:
 * a seeded machine-era config carries the clean template, and its exact
 * match converts to the action form the same way.
 */
const MERGE_PROMPT_SEED_TEMPLATE = `Merge pull request {external-key}: {title}.

### Instructions

1. **Squash and Merge**
   - Squash and merge the pull request into its base branch.
   - Close the related ticket if all acceptance criteria are satisfied.

2. **On a Blocked Merge**
   - If the pull request has a merge conflict or a failing CI check, do not merge.
   - Post a comment explaining the reason for the blocked merge.

Repository: {repository}
Pull request: {source-url}

Labels: {labels}

Description:
{description}`;

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
	const edges = tableList(originalData.workflows, "workflows");
	const shipped = parse(shippedDefaultText) as Record<string, unknown>;
	const shippedTaskTypes = isRecord(shipped["task-types"]) ? shipped["task-types"] : {};
	const taskTypes = isRecord(originalData["task-types"]) ? originalData["task-types"] : {};

	const statesOut = migrateStates({ rules, shipped });
	const transitionsOut = migrateTransitions({
		taskTypes,
		edges,
		stateForTask: statesOut.stateForTask,
	});
	const taskTypesOut = migrateTaskTypes({
		taskTypes,
		shippedTaskTypes,
		transitions: transitionsOut.transitions,
	});
	const { states, stateLines, installedParks } = statesOut;
	const { transitions, droppedEdges } = transitionsOut;
	const { newTaskTypes, templateLines, installedTransitions, autoCloseLines } = taskTypesOut;

	const { autoHandoffLine, priorityLine } = droppedKeyLines(originalData);
	const newData = reassembleConfig(originalData, states, newTaskTypes);

	// A file the machine keys mark is a workflow machine migration: the
	// pre-machine keys, and the pre-action merge seed template, which rides
	// the same rewrite (ADR 0068). A file only the retired Priority table
	// marks is a priority retirement (ADR 0050), and the two word their own
	// header and report title.
	const machineMigrated = isMachineMigration(originalData, autoCloseLines);
	const configText = buildConfigText({
		newData,
		backupFileName,
		reportFileName,
		machineMigrated,
		date,
	});
	const reportText = buildReportText({
		configPath,
		date,
		machineMigrated,
		backupFileName,
		reportFileName,
		stateLines,
		installedParks,
		transitions,
		installedTransitions,
		droppedEdges,
		templateLines,
		autoCloseLines,
		autoHandoffLine,
		priorityLine,
		originalData,
	});
	const noteText = machineMigrated
		? `the config at ${configPath} was migrated to the workflow machine; the pre-migration file is at ${backupFileName} and the report at ${reportFileName}`
		: `the config at ${configPath} was migrated off the retired priority table; the pre-migration file is at ${backupFileName} and the report at ${reportFileName}`;

	return { configText, reportText, backupFileName, reportFileName, noteText };
}

/** One state per rule, and the shipped machine's parking states. */
function migrateStates(fields: {
	rules: Record<string, unknown>[];
	shipped: Record<string, unknown>;
}): {
	states: Record<string, unknown>[];
	stateNames: Set<string>;
	stateForTask: Map<string, { name: string; match: Record<string, unknown> }>;
	stateLines: string[];
	installedParks: string[];
} {
	const { rules, shipped } = fields;
	// One state per rule: the state is named for the rule's task type, and
	// its match is the rule's when table, carried over verbatim.
	const states: Record<string, unknown>[] = [];
	const stateNames = new Set<string>();
	const stateForTask = new Map<string, { name: string; match: Record<string, unknown> }>();
	const stateLines: string[] = [];
	const installedParks: string[] = [];
	for (const rule of rules) {
		const state = ruleStateEntry(rule, stateNames);
		stateForTask.set(state.taskType, { name: state.name, match: state.match });
		states.push({ name: state.name, "task-type": state.taskType, match: { ...state.match } });
		stateLines.push(
			`- \`${state.name}\`: task \`${state.taskType}\`, matches ${matchDescription(state.match)}.`,
		);
	}
	// The shipped machine's parking states come over with the migration. The
	// default source list carries an open pull request before it holds a label,
	// so a config whose rules name only the labeled states would otherwise hand
	// the default task type to a stranger's pull request.
	const shippedStates = (Array.isArray(shipped.states) ? shipped.states : []).filter(isRecord);
	for (const shippedState of shippedStates) {
		if (shippedState["task-type"] !== undefined) continue;
		const name = shippedState.name;
		if (typeof name !== "string" || stateNames.has(name)) continue;
		if (!isRecord(shippedState.match)) continue;
		stateNames.add(name);
		states.push({ ...shippedState });
		installedParks.push(
			`\`${name}\`: the shipped seed's parking state, appended so a pull request the machine has not placed suggests nothing.`,
		);
	}
	return { states, stateNames, stateForTask, stateLines, installedParks };
}

/** The one state row one task rule carries into the new machine. */
function ruleStateEntry(
	rule: Record<string, unknown>,
	stateNames: Set<string>,
): { taskType: string; name: string; match: Record<string, unknown> } {
	// One state per rule: the state is named for the rule's task type, and
	// its match is the rule's when table, carried over verbatim.
	const taskType = rule["task-type"];
	if (typeof taskType !== "string" || taskType === "") {
		throw new ConfigMigrationError("a [[task-rules]] entry has no task-type string");
	}
	const match = isRecord(rule.when) ? rule.when : {};
	let name = taskType;
	for (let suffix = 2; stateNames.has(name); suffix++) name = `${taskType}-${suffix}`;
	stateNames.add(name);
	return { taskType, name, match };
}

/** One transition per expressible edge, and the edges it drops, named. */
function migrateTransitions(fields: {
	taskTypes: Record<string, unknown>;
	edges: Record<string, unknown>[];
	stateForTask: Map<string, { name: string; match: Record<string, unknown> }>;
}): {
	transitions: Map<string, { transition: Record<string, unknown>; line: string }>;
	droppedEdges: string[];
} {
	const { taskTypes, edges, stateForTask } = fields;
	// One transition per expressible edge: the single edge out of a task
	// type whose target one state suggests. The transition writes that
	// state's label facts, on the surface the state names, and it carries
	// the edge's pins.
	const transitions = new Map<string, { transition: Record<string, unknown>; line: string }>();
	const droppedEdges: string[] = [];
	for (const [taskType, rawTask] of Object.entries(taskTypes)) {
		if (!isRecord(rawTask)) continue;
		const out = migrateTransitionForTask({ taskType, edges, stateForTask });
		if (out.dropped !== undefined) droppedEdges.push(out.dropped);
		if (out.entry !== undefined) transitions.set(taskType, out.entry);
	}
	return { transitions, droppedEdges };
}

/** The one transition a task type's single outgoing edge expresses, if any. */
function migrateTransitionForTask(fields: {
	taskType: string;
	edges: Record<string, unknown>[];
	stateForTask: Map<string, { name: string; match: Record<string, unknown> }>;
}): { entry?: { transition: Record<string, unknown>; line: string }; dropped?: string } {
	const { taskType, edges, stateForTask } = fields;
	const fromEdges = edges.filter((edge) => edge.from === taskType);
	if (fromEdges.length === 0) return {};
	if (fromEdges.length > 1) {
		return {
			dropped: `the ${fromEdges.length} outgoing edges from \`${taskType}\`: a transition has one, and the edges offered a choice the machine's transitions do not express. Route them by hand from the decision modal.`,
		};
	}
	const edge = fromEdges[0];
	const targets = Array.isArray(edge.to) ? (edge.to as unknown[]) : [];
	if (targets.length !== 1 || typeof targets[0] !== "string" || targets[0] === "") {
		return {
			dropped: `the edge from \`${taskType}\` to ${targetList(targets)}: a transition's single edge must name exactly one task type.`,
		};
	}
	const target = targets[0] as string;
	const state = stateForTask.get(target);
	if (state === undefined) {
		return {
			dropped: `the edge from \`${taskType}\` to \`${target}\`: no state suggests \`${target}\`, so the transition has no facts to write.`,
		};
	}
	const facts = [
		...stringList(state.match["labels-all"]),
		...stringList(state.match["labels-any"]),
	];
	if (facts.length === 0) {
		return {
			dropped: `the edge from \`${taskType}\` to \`${target}\`: the state \`${state.name}\` matches without naming any labels, so it has no facts to write.`,
		};
	}
	const onPullRequest = state.match["source-kind"] === "github-pull-request";
	const transition: Record<string, unknown> = { "ticket-facts": [], "pull-request-facts": [] };
	if (onPullRequest) transition["pull-request-facts"] = facts;
	else transition["ticket-facts"] = facts;
	if (typeof edge.agent === "string") transition.agent = edge.agent;
	if (typeof edge.environment === "string") transition.environment = edge.environment;
	return {
		entry: {
			transition,
			line: `\`${taskType}\`: writes the ${onPullRequest ? "pull request" : "ticket"} facts ${labelList(facts)} (from the edge to \`${target}\` and the state \`${state.name}\`).`,
		},
	};
}

/**
 * Task types: auto-close is dropped (named), and a seed template that
 * matches the pre-machine seed exactly is replaced by the clean one. The
 * clean template drops the label prose that made the agents write the
 * labels, so the same exact match installs the shipped seed's transition on
 * that type when no edge expressed one: the plane takes over the labels the
 * template let go. A customized template keeps its prose and gets no
 * transition, and the report names it.
 */
function migrateTaskTypes(fields: {
	taskTypes: Record<string, unknown>;
	shippedTaskTypes: Record<string, unknown>;
	transitions: Map<string, { transition: Record<string, unknown>; line: string }>;
}): {
	newTaskTypes: Record<string, unknown>;
	templateLines: string[];
	installedTransitions: string[];
	autoCloseLines: string[];
} {
	const { taskTypes, shippedTaskTypes, transitions } = fields;
	const newTaskTypes: Record<string, unknown> = {};
	const templateLines: string[] = [];
	const installedTransitions: string[] = [];
	const autoCloseLines: string[] = [];
	for (const [name, rawTask] of Object.entries(taskTypes)) {
		if (!isRecord(rawTask)) {
			newTaskTypes[name] = rawTask;
			continue;
		}
		newTaskTypes[name] = migrateTaskType({
			name,
			rawTask,
			shippedTaskTypes,
			transition: transitions.get(name),
			templateLines,
			installedTransitions,
			autoCloseLines,
		});
	}
	return { newTaskTypes, templateLines, installedTransitions, autoCloseLines };
}

/** One task type, carried over with its retired keys and seed template judged. */
/** The one raw key one task type's row carries into its new row. */
function migrateTaskTypeKey(
	key: string,
	value: unknown,
	draft: { task: Record<string, unknown>; seedTemplateMatched: boolean },
	one: {
		name: string;
		shippedTaskTypes: Record<string, unknown>;
		templateLines: string[];
		autoCloseLines: string[];
	},
): void {
	if (key === "auto-close") {
		if (value === true) {
			one.autoCloseLines.push(
				`\`auto-close = true\` on \`${one.name}\`: dropped. Auto-handoff mode decides the route from the settled turn's Next step, so no flag replaces it.`,
			);
		}
		return;
	}
	if (key === "template" && typeof value === "string") {
		const replacement = seedTemplateReplacement(one.name, value, one.shippedTaskTypes);
		draft.task.template = replacement.template;
		draft.seedTemplateMatched = replacement.replaced;
		if (OLD_SEED_TEMPLATES[one.name] !== undefined) {
			one.templateLines.push(
				replacement.replaced
					? `\`${one.name}\`: replaced with the clean seed template (the pre-migration template matched the seed exactly).`
					: `\`${one.name}\`: left untouched (the template does not match the pre-migration seed). Its own label prose is the only writer of the labels this type's turns leave behind.`,
			);
		}
		return;
	}
	draft.task[key] = value;
}

function migrateTaskType(fields: {
	name: string;
	rawTask: Record<string, unknown>;
	shippedTaskTypes: Record<string, unknown>;
	transition: { transition: Record<string, unknown>; line: string } | undefined;
	templateLines: string[];
	installedTransitions: string[];
	autoCloseLines: string[];
}): Record<string, unknown> {
	const {
		name,
		rawTask,
		shippedTaskTypes,
		transition,
		templateLines,
		installedTransitions,
		autoCloseLines,
	} = fields;
	const task: Record<string, unknown> = {};
	const draft = { task, seedTemplateMatched: false };
	for (const [key, value] of Object.entries(rawTask)) {
		migrateTaskTypeKey(key, value, draft, {
			name,
			shippedTaskTypes,
			templateLines,
			autoCloseLines,
		});
	}
	const seedTemplateMatched = draft.seedTemplateMatched;
	const actionFormReplaced = applyMergeActionForm({ task, name, shippedTaskTypes, templateLines });
	if (transition !== undefined) {
		task.transition = transition.transition;
	} else if (seedTemplateMatched || actionFormReplaced) {
		const shippedTransition = shippedSeedTransition(name, shippedTaskTypes);
		if (shippedTransition !== undefined) {
			task.transition = shippedTransition;
			installedTransitions.push(
				`\`${name}\`: the shipped seed's transition, installed with the clean template or action form (no pre-migration edge expressed it).`,
			);
		}
	}
	return task;
}

/**
 * The merge's conversion to the action form (ADR 0068): a prompt-form
 * type whose template matched the shipped merge seed exactly takes the
 * action form the seed was replaced by, with its profile keys dropped -
 * the plane runs the merge, and the action holds no settings the
 * profile keys would edit. A customized template stays a prompt task
 * type, named in the report.
 */
function applyMergeActionForm(fields: {
	task: Record<string, unknown>;
	name: string;
	shippedTaskTypes: Record<string, unknown>;
	templateLines: string[];
}): boolean {
	const { task, name, shippedTaskTypes, templateLines } = fields;
	if (
		name !== "merge" ||
		typeof task.template !== "string" ||
		(task.template !== OLD_SEED_TEMPLATES.merge && task.template !== MERGE_PROMPT_SEED_TEMPLATE)
	) {
		return false;
	}
	const shippedTask = shippedTaskTypes.merge;
	if (isRecord(shippedTask) && typeof shippedTask.action === "string") {
		const previousTransition = task.transition;
		for (const key of Object.keys(task)) delete task[key];
		task.action = shippedTask.action;
		if (typeof shippedTask.method === "string") task.method = shippedTask.method;
		if (previousTransition !== undefined) task.transition = previousTransition;
		templateLines.push(
			`\`merge\`: converted to the action form (the template matched the shipped seed exactly). The merge runs on the plane, with no agent, and the action form's profile keys are dropped.`,
		);
		return true;
	}
	return false;
}

/** The lines the dropped keys leave in the report, where the file held them. */
function droppedKeyLines(originalData: Record<string, unknown>): {
	autoHandoffLine: string | null;
	priorityLine: string | null;
} {
	// The top-level `auto-handoff` key is the pre-ADR-0036 default for the
	// Auto-handoff mode, which lives in the state file the `a` key toggles:
	// the rewrite drops it and names the fact in the report.
	let autoHandoffLine: string | null = null;
	if ("auto-handoff" in originalData) {
		autoHandoffLine =
			`\`auto-handoff = ${String(originalData["auto-handoff"])}\`: dropped. The ` +
			`Auto-handoff mode is the state file's own fact the \`a\` key toggles ` +
			`(ADR 0036); the config no longer reads a default for it.`;
	}
	let priorityLine: string | null = null;
	if ("priority" in originalData) {
		priorityLine =
			`The \`[priority]\` table: dropped (ADR 0050). Ticket priority is retired; ` +
			`the Work queue's order the operator steers with \`+\` and \`-\` is the order ` +
			`of work, and the ticket list orders by attention: the newest external ` +
			`update first, then the ticket identity.`;
	}
	return { autoHandoffLine, priorityLine };
}

/**
 * Reassemble with the old key order: states take the task-rules
 * position, task-types keeps its own, and the old keys are gone.
 */
function reassembleConfig(
	originalData: Record<string, unknown>,
	states: Record<string, unknown>[],
	newTaskTypes: Record<string, unknown>,
): Record<string, unknown> {
	const newData: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(originalData)) {
		if (key === "task-rules") {
			newData.states = states;
			continue;
		}
		if (key === "workflows" || key === "auto-handoff" || key === "priority") continue;
		if (key === "task-types") {
			newData["task-types"] = newTaskTypes;
			continue;
		}
		newData[key] = value;
	}
	if (newData.states === undefined) newData.states = states;
	if (newData["task-types"] === undefined) newData["task-types"] = newTaskTypes;
	return newData;
}

/** Whether the file marks a workflow machine migration or a priority retirement. */
function isMachineMigration(
	originalData: Record<string, unknown>,
	autoCloseLines: string[],
): boolean {
	return (
		"task-rules" in originalData ||
		"workflows" in originalData ||
		autoCloseLines.length > 0 ||
		(isRecord(originalData["task-types"]) &&
			Object.values(originalData["task-types"]).some(
				(task) => isRecord(task) && oldMergeSeedMatch(task),
			))
	);
}

/** The migrated config, with the report's pointer lines on top. */
function buildConfigText(fields: {
	newData: Record<string, unknown>;
	backupFileName: string;
	reportFileName: string;
	machineMigrated: boolean;
	date: string;
}): string {
	const { newData, backupFileName, reportFileName, machineMigrated, date } = fields;
	const migrationHeader = machineMigrated
		? `# Migrated to the workflow machine on ${date} (ADR 0027).`
		: `# The retired [priority] table was removed on ${date} (ADR 0050).`;
	return [
		migrationHeader,
		`# The pre-migration file is at ${backupFileName}; the migration report at ${reportFileName}.`,
		"# The plane owns the workflow labels: states name the machine's states,",
		"# and each task type's transition writes the label facts its",
		"# completed turns leave behind.",
		"",
		stringify(newData),
	].join("\n");
}

/** The report's sections for a machine migration, in order. */
function machineReportSections(fields: {
	stateLines: string[];
	installedParks: string[];
	transitions: Map<string, { transition: Record<string, unknown>; line: string }>;
	installedTransitions: string[];
	droppedEdges: string[];
	templateLines: string[];
	autoCloseLines: string[];
}): string[] {
	const {
		stateLines,
		installedParks,
		transitions,
		installedTransitions,
		droppedEdges,
		templateLines,
		autoCloseLines,
	} = fields;
	return [
		...statesReportSection(stateLines, installedParks),
		...transitionsReportSection(transitions, installedTransitions, droppedEdges),
		...templatesReportSection(templateLines, autoCloseLines),
	];
}

function statesReportSection(stateLines: string[], installedParks: string[]): string[] {
	return [
		"## States",
		"",
		"Rules became states: one state per rule, named for the rule's task type,",
		"with the rule's match carried over.",
		"",
		...(stateLines.length > 0 ? stateLines : ["No task rules: no states were derived."]),
		...(installedParks.length > 0
			? ["", "Parking states appended from the shipped machine:", "", ...installedParks]
			: []),
		"",
	];
}

function transitionsReportSection(
	transitions: Map<string, { transition: Record<string, unknown>; line: string }>,
	installedTransitions: string[],
	droppedEdges: string[],
): string[] {
	return [
		"## Transitions",
		"",
		"Expressible edges became transitions: the transition writes the state",
		"label facts of the edge's single target, on the surface the state",
		"names, and carries the edge's agent and environment pins.",
		"",
		...(transitions.size > 0
			? [...transitions.values()].map((entry) => `- ${entry.line}`)
			: ["No edges were expressible as transitions."]),
		...(installedTransitions.length > 0
			? [
					"",
					"Transitions installed from the shipped seed with the clean template:",
					"",
					...installedTransitions.map((line) => `- ${line}`),
				]
			: []),
		...(droppedEdges.length > 0
			? ["", "Dropped edges, named:", "", ...droppedEdges.map((line) => `- ${line}`)]
			: []),
		"",
	];
}

function templatesReportSection(templateLines: string[], autoCloseLines: string[]): string[] {
	return [
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
	];
}

/** The report: what the rewrite did, in the sections the machine migration names. */
function buildReportText(fields: {
	configPath: string;
	date: string;
	machineMigrated: boolean;
	backupFileName: string;
	reportFileName: string;
	stateLines: string[];
	installedParks: string[];
	transitions: Map<string, { transition: Record<string, unknown>; line: string }>;
	installedTransitions: string[];
	droppedEdges: string[];
	templateLines: string[];
	autoCloseLines: string[];
	autoHandoffLine: string | null;
	priorityLine: string | null;
	originalData: Record<string, unknown>;
}): string {
	const {
		configPath,
		date,
		machineMigrated,
		backupFileName,
		reportFileName,
		stateLines,
		installedParks,
		transitions,
		installedTransitions,
		droppedEdges,
		templateLines,
		autoCloseLines,
		autoHandoffLine,
		priorityLine,
		originalData,
	} = fields;
	const migrationTitle = machineMigrated ? "Workflow machine migration" : "Priority retirement";
	// The report says what the rewrite did. A machine migration rewrote the
	// whole workflow: its sections name the states, the transitions, and the
	// templates. A priority-only rewrite touched one table: its sections name
	// that table and nothing else, so the file never claims a change it did
	// not make (ADR 0050).
	const machineSections = machineMigrated
		? machineReportSections({
				stateLines,
				installedParks,
				transitions,
				installedTransitions,
				droppedEdges,
				templateLines,
				autoCloseLines,
			})
		: [
				"## Dropped keys",
				"",
				"The rewrite removed one table and changed no other value: the states,",
				"the transitions, and the templates in the file are the ones the file",
				"already carried.",
			];
	return [
		`# ${migrationTitle}`,
		"",
		`The config at \`${configPath}\` carried ${
			machineMigrated ? "the pre-workflow-machine keys" : "the retired [priority] table"
		}. The`,
		`control plane rewrote it at load on ${date} (${machineMigrated ? "ADR 0027" : "ADR 0050"}). The pre-migration`,
		`file is at \`${backupFileName}\`, next to the config, and this report at \`${reportFileName}\`.`,
		"",
		...machineSections,
		...(autoHandoffLine === null ? [] : ["", autoHandoffLine]),
		...(priorityLine === null ? [] : ["", priorityLine]),
		...behaviorChangesSection(machineMigrated, originalData, backupFileName),
	].join("\n");
}

/** The report's closing section: what the operator's machine must now do differently. */
function behaviorChangesSection(
	machineMigrated: boolean,
	originalData: Record<string, unknown>,
	backupFileName: string,
): string[] {
	return [
		"",
		"## Behavior changes to know",
		"",
		`The rewrite serializes the config: the data round-trips, but operator`,
		`comments in the file are dropped. The backup at \`${backupFileName}\` keeps`,
		"them.",
		"",
		...(machineMigrated && ("task-rules" in originalData || "workflows" in originalData)
			? [
					"The default source list is wider than the pre-migration default. The",
					"issue source now lists every open issue that is not `blocked`, and",
					"the pull request source lists every open pull request that is not a",
					"draft unless it carries `needs-work`. With auto-handoff on, the",
					"default task type now hands off every open issue the machine has not",
					"placed in a state. Tighten a source's `filter` to keep the old",
					"narrower list.",
				]
			: []),
		"",
	];
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
 * The transition the shipped Default configuration carries for one task type,
 * as a raw table. The migration installs it on a task type whose seed template
 * matched exactly and whose pre-machine config expressed no edge.
 */
function shippedSeedTransition(
	name: string,
	shippedTaskTypes: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const shippedTask = shippedTaskTypes[name];
	if (!isRecord(shippedTask) || !isRecord(shippedTask.transition)) return undefined;
	return shippedTask.transition;
}

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
		else if (Array.isArray(value))
			parts.push(`${key} ${value.map((item) => `\`${String(item)}\``).join(", ")}`);
	}
	return parts.length > 0 ? parts.join(", ") : "everything (a catch-all)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
