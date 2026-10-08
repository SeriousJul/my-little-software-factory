/**
 * The Quality audit (ADR 0120, ADR 0121, issue #340).
 *
 * One command checks the tree and prints one payload on stdout: a status
 * line, one count per metric, and the findings as `path:line rule message`.
 * It runs the type check, Biome over the audit's scope with the audit's
 * config, jscpd over its scope, and one `gh api` read of the open
 * code-scanning alerts. It runs no test suite, and it writes nothing inside
 * the worktree: jscpd's JSON report lands in a temp directory outside the
 * repository and is removed.
 *
 * The script owns no number: the Biome rules and thresholds stand in
 * `biome.json` and `.quality/biome.json`, the jscpd thresholds in
 * `.jscpd.json`, the audit's own values (the metric list, the scopes, the
 * finding cap, and the changed base) in `.quality.json`, and the baseline
 * counts in `.quality-baseline.json`.
 *
 * The baseline only shrinks: a count above it fails the audit, and a count
 * below it fails until it is rewritten down in the same change. Issue #350
 * is the campaign that shrinks it. A non-zero exit means the tree is worse
 * than its baseline: a type error, a lint error, a duplication clone above
 * the baseline, or any count above its baseline. The code-scanning read
 * never fails the audit on its own; a failed read prints its reason as a
 * fact line.
 *
 * `--changed` lists only findings in files that differ from the changed
 * base, which `.quality.json` states and `QUALITY_CHANGED_BASE` overrides,
 * and never the counts, so the ratchet never reads a partial tree.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The audit's config file, which states its own values. */
const QUALITY_CONFIG = ".quality.json";
/** The baseline file, which stands beside the config. */
const QUALITY_BASELINE = ".quality-baseline.json";
/** The directory of the audit's Biome config, passed to Biome's `--config-path`. */
const BIOME_CONFIG_DIR = ".quality";
/** The one code-scanning read: the open alerts of this repository. */
const CODEQL_ENDPOINT = "/repos/:owner/:repo/code-scanning/alerts?state=open&per_page=100";
/** The count metrics the baseline can hold, in the payload's order. */
const BASELINE_METRICS = ["cognitive", "function", "params", "duplicates"] as const;

/** One count metric of the payload, in its line order. */
type MetricName = "type" | "lint" | "secrets" | "cognitive" | "function" | "params" | "duplicates";

/** A finding of one metric, printed as `file:line <text>`. */
export interface Finding {
	/** The file the finding stands in, relative to the repository root. */
	file: string;
	/** The line the finding stands on. */
	line: number;
	/** The `rule message` text after `file:line`. */
	text: string;
	/** The second file of a duplicate finding, for the `--changed` narrowing. */
	also?: string;
}

/** The value the audit measured for one metric, beside the baseline it holds. */
export interface MetricReading {
	name: MetricName;
	/** The count measured on this tree. */
	measured: number;
	/** The baseline count, when the metric holds one. */
	baseline?: number;
	/** The findings of the metric, before the `--changed` narrowing and the cap. */
	findings: Finding[];
}

/** The one code-scanning read, or the reason it failed. */
export interface CodeqlReading {
	/** Present when the read succeeded: the open alert count. */
	count?: number;
	/** Present when the read failed: the reason it failed. */
	failed?: string;
	findings: Finding[];
}

/** The verdict of one count against its baseline. */
export type Verdict = "ok" | "above" | "below";

/**
 * The verdict of one count against its baseline. A metric that holds no
 * baseline allows zero only: any count above zero is above. A metric that
 * holds one ratchets both ways: above fails, and below fails until the
 * baseline is rewritten down in the same change.
 */
export function verdictOf(measured: number, baseline: number | undefined): Verdict {
	if (baseline === undefined) {
		return measured > 0 ? "above" : "ok";
	}
	if (measured > baseline) {
		return "above";
	}
	if (measured < baseline) {
		return "below";
	}
	return "ok";
}

/** The audit's status: `FAILED` when any count is above or below its baseline. */
export function auditStatus(metrics: readonly MetricReading[]): "OK" | "FAILED" {
	for (const reading of metrics) {
		if (verdictOf(reading.measured, reading.baseline) !== "ok") {
			return "FAILED";
		}
	}
	return "OK";
}

/** One metric line of the payload: the name at its column, then the count. */
export function metricLine(reading: MetricReading): string {
	const value =
		reading.baseline === undefined
			? String(reading.measured)
			: `${reading.measured} / baseline ${reading.baseline}`;
	return `${reading.name.padEnd(14)}${value}`;
}

/** The code-scanning line: the open alert count, or the reason the read failed. */
export function codeqlLine(reading: CodeqlReading): string {
	const value =
		reading.count !== undefined
			? `${reading.count} open alert${reading.count === 1 ? "" : "s"}`
			: `read failed: ${reading.failed ?? "no reason"}`;
	return `codeql`.padEnd(14) + value;
}

/** The finding line without its indent: `file:line rule message`. */
export function findingLine(finding: Finding): string {
	return `${finding.file}:${finding.line} ${finding.text}`;
}

/**
 * The findings a metric prints: at most `cap` lines, and one `and N more`
 * line when the cap hides findings.
 */
export function cappedFindings(
	findings: readonly Finding[],
	cap: number,
): { lines: string[]; more: number } {
	const shown = findings.slice(0, cap);
	return { lines: shown.map(findingLine), more: findings.length - shown.length };
}

/** The input of one payload, gathered by the audit before it prints. */
export interface PayloadInput {
	status: "OK" | "FAILED";
	/** The short head the run stands on. */
	head: string;
	/** The run's cost, in seconds. */
	seconds: number;
	metrics: readonly MetricReading[];
	codeql: CodeqlReading;
	/** The cap on findings printed per metric. */
	cap: number;
}

function appendFindings(into: string[], cap: number, findings: readonly Finding[]): void {
	const capped = cappedFindings(findings, cap);
	for (const line of capped.lines) {
		into.push(`  ${line}`);
	}
	if (capped.more > 0) {
		into.push(`  and ${capped.more} more`);
	}
}

/**
 * The payload: a status line, one line per metric, the code-scanning line,
 * then the findings as `  path:line rule message`, capped per metric with
 * one `and N more` line. No findings, no findings section.
 */
export function buildPayload(input: PayloadInput): string {
	const lines = [`audit ${input.status}  head ${input.head}  ${input.seconds.toFixed(1)} s`];
	for (const reading of input.metrics) {
		lines.push(metricLine(reading));
	}
	lines.push(codeqlLine(input.codeql));
	const findingLines: string[] = [];
	for (const reading of input.metrics) {
		appendFindings(findingLines, input.cap, reading.findings);
	}
	appendFindings(findingLines, input.cap, input.codeql.findings);
	if (findingLines.length > 0) {
		lines.push("findings");
		lines.push(...findingLines);
	}
	return lines.join("\n");
}

/** The values `.quality.json` states for the audit. */
export interface QualityConfig {
	metrics: string[];
	scopes: {
		biome: string[];
		jscpd: string[];
	};
	"finding-cap": number;
	"changed-base": string;
}

/** The values `.quality-baseline.json` states, one count per metric. */
export interface QualityBaseline {
	/** The short head the counts were measured on. */
	"measured-on": string;
	cognitive: number;
	function: number;
	params: number;
	duplicates: number;
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function baselineCount(baseline: QualityBaseline, name: MetricName): number | undefined {
	if ((BASELINE_METRICS as readonly string[]).includes(name)) {
		return baseline[name as (typeof BASELINE_METRICS)[number]];
	}
	return undefined;
}

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** Present when the executable could not start at all. */
	error?: string;
}

/** One command, run with the repository root as its working directory. */
function spawn(args: string[], root: string): SpawnResult {
	try {
		const result = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { exitCode: 127, stdout: "", stderr: "", error: reason };
	}
}

/** The reason a command failed, as one fact line. */
export function spawnFailureReason(result: SpawnResult): string {
	if (result.error !== undefined) {
		return result.error;
	}
	const line = result.stderr.split("\n").find((entry) => entry.trim() !== "");
	if (line !== undefined) {
		return line;
	}
	return `the command exited with code ${result.exitCode}`;
}

/** One git read from the repository root, or the reason it failed. */
function git(root: string, args: string[]): string {
	const result = spawn(["git", ...args], root);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${spawnFailureReason(result)}`);
	}
	return result.stdout;
}

/** The files that differ from the changed base, or that are untracked. */
function changedFiles(root: string, base: string): Set<string> {
	const files = new Set<string>();
	for (const line of git(root, ["diff", "--name-only", base]).split("\n")) {
		if (line !== "") {
			files.add(line);
		}
	}
	for (const line of git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
		if (line !== "") {
			files.add(line);
		}
	}
	return files;
}

/** One type error of `tsc --noEmit`, from its `path(line,column): error TSxxxx:` line. */
function typeFindings(text: string): Finding[] {
	const findings: Finding[] = [];
	for (const line of text.split("\n")) {
		const match = /^(\S[^(]*)\((\d+)(?:,\d+)?\): error (TS\d+): (.+)$/.exec(line);
		if (match === null) {
			continue;
		}
		findings.push({
			file: match[1],
			line: Number(match[2]),
			text: `type ${match[3]}: ${match[4]}`,
		});
	}
	return findings;
}

/** The type metric: the count of `tsc --noEmit` errors and their lines. */
function typeCheck(root: string): { count: number; findings: Finding[] } {
	const result = spawn([join(root, "node_modules", ".bin", "tsc"), "--noEmit"], root);
	const findings = typeFindings(result.stdout);
	if (result.exitCode === 0 || findings.length > 0) {
		return { count: findings.length, findings };
	}
	const first =
		result.stdout
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line !== "") ?? result.stderr.trim();
	return { count: 1, findings: [{ file: "tsc", line: 0, text: `type ${first}` }] };
}

/** One diagnostic of Biome's JSON reporter. */
interface BiomeDiagnostic {
	severity: string;
	message: string;
	category: string;
	location: {
		path: string;
		start: { line: number; column: number };
	};
}

/** The metric one Biome diagnostic stands for. */
function biomeMetric(category: string): MetricName {
	if (category === "lint/complexity/noExcessiveCognitiveComplexity") {
		return "cognitive";
	}
	if (category === "lint/complexity/noExcessiveLinesPerFunction") {
		return "function";
	}
	if (category === "lint/complexity/useMaxParams") {
		return "params";
	}
	if (category === "lint/security/noSecrets") {
		return "secrets";
	}
	return "lint";
}

/** The finding text of one Biome diagnostic, in the `rule message` form. */
function biomeText(metric: MetricName, message: string): string {
	const cognitive = /Excessive complexity of (\d+) detected \(max: (\d+)\)/.exec(message);
	if (metric === "cognitive" && cognitive !== null) {
		return `cognitive ${cognitive[1]} over ${cognitive[2]}`;
	}
	const length = /too many lines \((\d+)\)\. Maximum allowed is (\d+)/.exec(message);
	if (metric === "function" && length !== null) {
		return `function ${length[1]} over ${length[2]}`;
	}
	const params = /Function has (\d+) parameters, but only (\d+) are allowed/.exec(message);
	if (metric === "params" && params !== null) {
		return `params ${params[1]} over ${params[2]}`;
	}
	return `${metric} ${message}`;
}

/** The findings of the audit's Biome run, bucketed by metric. */
function biomeFindings(diagnostics: readonly BiomeDiagnostic[]): Record<string, Finding[]> {
	const buckets: Record<string, Finding[]> = {};
	for (const diagnostic of diagnostics) {
		if (diagnostic.severity !== "error") {
			continue;
		}
		const metric = biomeMetric(diagnostic.category);
		const finding: Finding = {
			file: diagnostic.location.path,
			line: diagnostic.location.start.line,
			text: biomeText(metric, diagnostic.message),
		};
		if (buckets[metric] === undefined) {
			buckets[metric] = [];
		}
		buckets[metric].push(finding);
	}
	return buckets;
}

/**
 * The audit's Biome run: the explicit paths of the scope, the audit's
 * config, and the JSON reporter, which prints every diagnostic.
 */
function biomeCheck(root: string, scope: string[]): BiomeDiagnostic[] {
	const command = [
		join(root, "node_modules", ".bin", "biome"),
		"check",
		...scope,
		"--config-path",
		BIOME_CONFIG_DIR,
		"--reporter=json",
	];
	const result = spawn(command, root);
	if (result.stdout.trim() === "") {
		throw new Error(`biome check wrote no report: ${spawnFailureReason(result)}`);
	}
	const report = JSON.parse(result.stdout) as { diagnostics: BiomeDiagnostic[] };
	return report.diagnostics;
}

/** One fragment of jscpd's JSON report. */
interface JscpdFragment {
	name: string;
	start: number;
}

/** One duplicate of jscpd's JSON report. */
interface JscpdDuplicate {
	firstFile: JscpdFragment;
	secondFile: JscpdFragment;
	tokens: number;
}

/** The JSON report jscpd writes to its output directory. */
interface JscpdReport {
	duplicates: JscpdDuplicate[];
}

/** The jscpd scope and the root its fragment names resolve against. */
interface JscpdInput {
	report: JscpdReport;
	scope: string[];
	root: string;
}

/**
 * A jscpd fragment name, resolved to its path in the repository: jscpd
 * names fragments relative to the scope root it scanned them from.
 */
function scopePath(input: JscpdInput, name: string): string {
	for (const scope of input.scope) {
		if (existsSync(join(input.root, scope, name))) {
			return join(scope, name);
		}
	}
	return name;
}

/** The duplicate findings of the jscpd report, in file and line order. */
function duplicateFindings(input: JscpdInput): Finding[] {
	const findings: Finding[] = [];
	for (const duplicate of input.report.duplicates) {
		const first = scopePath(input, duplicate.firstFile.name);
		const second = scopePath(input, duplicate.secondFile.name);
		findings.push({
			file: first,
			line: duplicate.firstFile.start,
			text: `duplicate of ${second}:${duplicate.secondFile.start}, ${duplicate.tokens} tokens`,
			also: second,
		});
	}
	return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * The jscpd run: the scope as its paths, its settings from `.jscpd.json`,
 * and the JSON report written to the temp directory outside the worktree.
 */
function jscpdReport(root: string, scope: string[], tempDir: string): JscpdReport {
	const result = spawn(
		[join(root, "node_modules", ".bin", "jscpd"), ...scope, "--output", tempDir],
		root,
	);
	const reportPath = join(tempDir, "jscpd-report.json");
	if (!existsSync(reportPath)) {
		throw new Error(`jscpd wrote no report: ${spawnFailureReason(result)}`);
	}
	return JSON.parse(readFileSync(reportPath, "utf8")) as JscpdReport;
}

/** One open alert of the code-scanning read, as the payload prints it. */
interface CodeqlAlert {
	path: string;
	line: number;
	rule: string;
}

/** One alert of the `gh api` read, in its wire shape. */
interface CodeqlAlertWire {
	rule?: { id?: string };
	most_recent_instance?: { location?: { path?: string; start_line?: number } };
}

function alertOf(wire: CodeqlAlertWire): CodeqlAlert {
	const location = wire.most_recent_instance?.location;
	return {
		path: location?.path ?? "(unknown path)",
		line: location?.start_line ?? 0,
		rule: wire.rule?.id ?? "(unknown rule)",
	};
}

/** The code-scanning line's findings, in file and line order. */
function codeqlFindings(alerts: readonly CodeqlAlert[]): Finding[] {
	const findings: Finding[] = [];
	for (const alert of alerts) {
		findings.push({ file: alert.path, line: alert.line, text: `codeql ${alert.rule}` });
	}
	return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** The outcome of the one code-scanning read. */
type CodeqlOutcome = { kind: "read"; alerts: CodeqlAlert[] } | { kind: "failed"; reason: string };

/**
 * The one code-scanning read. It fails open to a fact line: a missing
 * `gh`, a missing auth, and a refused read all report their reason, and
 * none of them fails the audit.
 */
function codeScanning(root: string): CodeqlOutcome {
	const result = spawn(["gh", "api", CODEQL_ENDPOINT], root);
	if (result.error?.includes("Executable not found")) {
		return { kind: "failed", reason: "gh is not installed" };
	}
	if (result.exitCode !== 0) {
		return { kind: "failed", reason: spawnFailureReason(result) };
	}
	try {
		const wire = JSON.parse(result.stdout) as CodeqlAlertWire[];
		return { kind: "read", alerts: wire.map(alertOf) };
	} catch {
		return { kind: "failed", reason: "the code-scanning read returned no list of alerts" };
	}
}

/**
 * The metric readings of one run: the counts whole, and the findings in
 * the order the cap and the `--changed` narrowing act on them.
 */
function metricReadings(
	config: QualityConfig,
	baseline: QualityBaseline,
	findings: Record<string, Finding[]>,
): MetricReading[] {
	const readings: MetricReading[] = [];
	for (const name of config.metrics) {
		const metric = name as MetricName;
		const all = findings[metric] ?? [];
		readings.push({
			name: metric,
			measured: all.length,
			baseline: baselineCount(baseline, metric),
			findings: all,
		});
	}
	return readings;
}

/** The `--changed` narrowing: the findings in the files that differ. */
function narrowFindings(findings: Finding[], changed: Set<string>): Finding[] {
	return findings.filter(
		(finding) =>
			changed.has(finding.file) || (finding.also !== undefined && changed.has(finding.also)),
	);
}

/** The audit run: the payload on stdout, and the exit code the status states. */
function run(): number {
	const root = process.cwd();
	const started = Date.now();
	const config = readJson<QualityConfig>(join(root, QUALITY_CONFIG));
	const baseline = readJson<QualityBaseline>(join(root, QUALITY_BASELINE));
	const head = git(root, ["rev-parse", "--short=8", "HEAD"]).trim();
	const changedBase = process.env.QUALITY_CHANGED_BASE ?? config["changed-base"];
	const changed = process.argv.slice(2).includes("--changed")
		? changedFiles(root, changedBase)
		: undefined;
	const tempDir = mkdtempSync(join(tmpdir(), "mlsf-quality-audit-"));
	try {
		const type = typeCheck(root);
		const diagnostics = biomeCheck(root, config.scopes.biome);
		const report = jscpdReport(root, config.scopes.jscpd, tempDir);
		const scanning = codeScanning(root);
		const findings: Record<string, Finding[]> = {
			...biomeFindings(diagnostics),
			type: type.findings,
		};
		findings.duplicates = duplicateFindings({ report, scope: config.scopes.jscpd, root });
		const codeql: CodeqlReading =
			scanning.kind === "read"
				? { count: scanning.alerts.length, findings: codeqlFindings(scanning.alerts) }
				: { failed: scanning.reason, findings: [] };
		let readings = metricReadings(config, baseline, findings);
		if (changed !== undefined) {
			readings = readings.map((reading) => ({
				...reading,
				findings: narrowFindings(reading.findings, changed),
			}));
			codeql.findings = narrowFindings(codeql.findings, changed);
		}
		const status = auditStatus(readings);
		const seconds = (Date.now() - started) / 1000;
		process.stdout.write(
			`${buildPayload({
				status,
				head,
				seconds,
				metrics: readings,
				codeql,
				cap: config["finding-cap"],
			})}\n`,
		);
		return status === "OK" ? 0 : 1;
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	process.exitCode = run();
}
