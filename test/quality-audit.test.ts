/**
 * The Quality audit's payload and baseline stand as ADR 0120 and ADR 0121
 * state them (issue #340).
 *
 * The payload is a line form: a status line, one count per metric, then the
 * findings as `  path:line rule message`, capped per metric with one `and N
 * more` line. These tests pin that grammar, read every baseline count back
 * from `.quality-baseline.json`, and hold the ratchet both ways: a count
 * above the baseline fails, and a count below it fails until the file is
 * rewritten down in the same change. The last test runs the real command and
 * holds that `--changed` narrows the findings and never the counts.
 *
 * The probes the quality gate's probe rule asks for, written as steps and
 * each re-run on the tree, by hand:
 *
 * - Probe 1, the duplication teeth: paste a block of at least 100 tokens
 *   that already stands elsewhere in `src` into a function of `src`. The
 *   `duplicates` count grows by one and the audit exits non-zero.
 * - Probe 2, the cognitive teeth: raise one function's cognitive score past
 *   15 by nesting an `if` in a body that already stands over 15. The
 *   `cognitive` count grows by one and the audit exits non-zero.
 * - Probe 3, the ratchet: lower one count in `.quality-baseline.json` below
 *   the count the tree stands at. The audit exits non-zero and prints that
 *   count below its baseline.
 * - Probe 4, the secrets rule: plant a high-entropy 32-character token in a
 *   file under `src`. The `secrets` count grows by one and the audit exits
 *   non-zero.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	auditStatus,
	buildPayload,
	type CodeqlReading,
	cappedFindings,
	codeqlLine,
	findingLine,
	type MetricReading,
	metricLine,
	verdictOf,
} from "../scripts/quality-audit.ts";

const ROOT = join(import.meta.dir, "..");

/** One baseline file, as the audit reads it. */
interface BaselineFile {
	"measured-on": string;
	cognitive: number;
	function: number;
	params: number;
	duplicates: number;
}

/** One audit config, as the audit reads it. */
interface ConfigFile {
	metrics: string[];
	scopes: { biome: string[]; jscpd: string[] };
	"finding-cap": number;
	"changed-base": string;
}

/** The readings at the baseline's own counts, in the payload's metric order. */
const BASELINE_READINGS: MetricReading[] = [
	{ name: "type", measured: 0, findings: [] },
	{ name: "lint", measured: 0, findings: [] },
	{ name: "secrets", measured: 0, findings: [] },
	{ name: "cognitive", measured: 168, baseline: 168, findings: [] },
	{ name: "function", measured: 86, baseline: 86, findings: [] },
	{ name: "params", measured: 49, baseline: 49, findings: [] },
	{ name: "duplicates", measured: 11, baseline: 11, findings: [] },
];

/** The baseline readings with the count of the metric at `index` set to `count`. */
function withCount(index: number, count: number): MetricReading[] {
	return BASELINE_READINGS.map((reading, at) =>
		at === index ? { ...reading, measured: count } : reading,
	);
}

describe("the Quality audit's payload", () => {
	test("the payload prints the status line, the counts, and the findings in the one form", () => {
		const payload = buildPayload({
			status: "FAILED",
			head: "b4c305e6",
			seconds: 1.94,
			metrics: [
				{ name: "type", measured: 0, findings: [] },
				{ name: "lint", measured: 0, findings: [] },
				{ name: "secrets", measured: 0, findings: [] },
				{
					name: "cognitive",
					measured: 2,
					baseline: 168,
					findings: [
						{ file: "src/handoff-dispatch.ts", line: 1926, text: "cognitive 41 over 15" },
						{ file: "src/app.ts", line: 10, text: "cognitive 16 over 15" },
					],
				},
				{ name: "function", measured: 0, baseline: 86, findings: [] },
				{ name: "params", measured: 0, baseline: 49, findings: [] },
				{
					name: "duplicates",
					measured: 1,
					baseline: 11,
					findings: [
						{
							file: "src/components/action-panel.ts",
							line: 118,
							text: "duplicate of src/components/missing-modal.ts:126, 106 tokens",
						},
					],
				},
			],
			codeql: { count: 6, findings: [] },
			cap: 20,
		});
		expect(payload).toBe(
			[
				"audit FAILED  head b4c305e6  1.9 s",
				"type          0",
				"lint          0",
				"secrets       0",
				"cognitive     2 / baseline 168",
				"function      0 / baseline 86",
				"params        0 / baseline 49",
				"duplicates    1 / baseline 11",
				"codeql        6 open alerts",
				"findings",
				"  src/handoff-dispatch.ts:1926 cognitive 41 over 15",
				"  src/app.ts:10 cognitive 16 over 15",
				"  src/components/action-panel.ts:118 duplicate of src/components/missing-modal.ts:126, 106 tokens",
			].join("\n"),
		);
	});

	test("a clean tree prints no findings section", () => {
		const payload = buildPayload({
			status: "OK",
			head: "b4c305e6",
			seconds: 1.1,
			metrics: BASELINE_READINGS,
			codeql: { count: 0, findings: [] },
			cap: 20,
		});
		expect(payload).toBe(
			[
				"audit OK  head b4c305e6  1.1 s",
				"type          0",
				"lint          0",
				"secrets       0",
				"cognitive     168 / baseline 168",
				"function      86 / baseline 86",
				"params        49 / baseline 49",
				"duplicates    11 / baseline 11",
				"codeql        0 open alerts",
			].join("\n"),
		);
	});

	test("findings cap per metric, with one and N more line", () => {
		const findings = Array.from({ length: 21 }, (_, index) => ({
			file: `src/file-${index}.ts`,
			line: index + 1,
			text: "cognitive 16 over 15",
		}));
		const capped = cappedFindings(findings, 20);
		expect(capped.lines).toHaveLength(20);
		expect(capped.more).toBe(1);
		expect(capped.lines[0]).toBe("src/file-0.ts:1 cognitive 16 over 15");
		const payload = buildPayload({
			status: "FAILED",
			head: "b4c305e6",
			seconds: 1.0,
			metrics: [
				{ name: "type", measured: 0, findings: [] },
				{ name: "cognitive", measured: 21, baseline: 168, findings },
			],
			codeql: { count: 0, findings: [] },
			cap: 20,
		});
		expect(payload.endsWith("  and 1 more")).toBe(true);
	});

	test("a metric line pads the name and states the count beside its baseline", () => {
		expect(metricLine({ name: "type", measured: 0, findings: [] })).toBe("type          0");
		expect(metricLine({ name: "cognitive", measured: 169, baseline: 168, findings: [] })).toBe(
			"cognitive     169 / baseline 168",
		);
	});

	test("a finding line is the file, the line, and the rule message", () => {
		expect(findingLine({ file: "src/app.ts", line: 3, text: "cognitive 41 over 15" })).toBe(
			"src/app.ts:3 cognitive 41 over 15",
		);
	});

	test("the code-scanning line states the count, or the reason the read failed", () => {
		expect(codeqlLine({ count: 6, findings: [] } as CodeqlReading)).toBe(
			"codeql        6 open alerts",
		);
		expect(codeqlLine({ count: 1, findings: [] } as CodeqlReading)).toBe(
			"codeql        1 open alert",
		);
		expect(codeqlLine({ failed: "gh is not installed", findings: [] } as CodeqlReading)).toBe(
			"codeql        read failed: gh is not installed",
		);
	});
});

describe("the Quality baseline ratchets both ways", () => {
	test("a count above its baseline fails", () => {
		expect(verdictOf(169, 168)).toBe("above");
		expect(verdictOf(12, 11)).toBe("above");
		// A metric that holds no baseline allows zero only.
		expect(verdictOf(1, undefined)).toBe("above");
		expect(verdictOf(0, undefined)).toBe("ok");
	});

	test("a count below its baseline fails until the baseline is rewritten down", () => {
		expect(verdictOf(167, 168)).toBe("below");
		expect(verdictOf(168, 168)).toBe("ok");
	});

	test("the audit fails on any count above or below its baseline", () => {
		// The metric order: type 0, lint 1, secrets 2, cognitive 3, function 4,
		// params 5, duplicates 6.
		expect(auditStatus(BASELINE_READINGS)).toBe("OK");
		expect(auditStatus(withCount(3, 169))).toBe("FAILED");
		expect(auditStatus(withCount(3, 167))).toBe("FAILED");
		expect(auditStatus(withCount(0, 1))).toBe("FAILED");
		expect(auditStatus(withCount(1, 1))).toBe("FAILED");
		expect(auditStatus(withCount(2, 1))).toBe("FAILED");
		expect(auditStatus(withCount(4, 87))).toBe("FAILED");
		expect(auditStatus(withCount(5, 48))).toBe("FAILED");
		expect(auditStatus(withCount(6, 12))).toBe("FAILED");
	});
});

describe("the dotfiles state the audit's values", () => {
	test("the baseline holds the four counts, one per metric, beside the head they were measured on", () => {
		const baseline = JSON.parse(
			readFileSync(join(ROOT, ".quality-baseline.json"), "utf8"),
		) as BaselineFile;
		expect(baseline.cognitive).toBe(167);
		expect(baseline.function).toBe(87);
		expect(baseline.params).toBe(49);
		expect(baseline.duplicates).toBe(11);
		expect(baseline["measured-on"]).toMatch(/^[0-9a-f]{7,40}$/);
		expect(Object.keys(baseline).sort()).toEqual([
			"cognitive",
			"duplicates",
			"function",
			"measured-on",
			"params",
		]);
	});

	test("the audit config states the metric list, the scopes, the cap, and the changed base", () => {
		const config = JSON.parse(readFileSync(join(ROOT, ".quality.json"), "utf8")) as ConfigFile;
		expect(config.metrics).toEqual([
			"type",
			"lint",
			"secrets",
			"cognitive",
			"function",
			"params",
			"duplicates",
		]);
		expect(config.scopes.biome).toEqual(["src", "scripts", "bin", "test"]);
		expect(config.scopes.jscpd).toEqual(["src", "scripts", "bin"]);
		expect(config["finding-cap"]).toBe(20);
		expect(config["changed-base"]).toBe("origin/main");
	});
});

describe("the audit command", () => {
	function runAudit(args: string[]): { code: number; lines: string[] } {
		const result = Bun.spawnSync(
			[process.execPath, join(ROOT, "scripts", "quality-audit.ts"), ...args],
			{
				cwd: ROOT,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		return { code: result.exitCode, lines: result.stdout.toString().split("\n") };
	}

	test("bun run audit prints the payload, and --changed keeps the counts whole", () => {
		const plain = runAudit([]);
		const changed = runAudit(["--changed"]);
		// The status line: the status, the head, the cost.
		expect(plain.lines[0]).toMatch(/^audit (OK|FAILED) {2}head [0-9a-f]{7,40} {2}\d+\.\d s$/);
		// The count lines, one per metric, in the payload's order.
		expect(plain.lines[1]).toMatch(/^type {10}\d+$/);
		expect(plain.lines[2]).toMatch(/^lint {10}\d+$/);
		expect(plain.lines[3]).toMatch(/^secrets {7}\d+$/);
		expect(plain.lines[4]).toMatch(/^cognitive {5}\d+ \/ baseline \d+$/);
		expect(plain.lines[5]).toMatch(/^function {6}\d+ \/ baseline \d+$/);
		expect(plain.lines[6]).toMatch(/^params {8}\d+ \/ baseline \d+$/);
		expect(plain.lines[7]).toMatch(/^duplicates {4}\d+ \/ baseline \d+$/);
		expect(plain.lines[8]).toMatch(/^codeql {8}(\d+ open alerts|read failed: .+)$/);
		// The counts are the facts the ratchet reads: --changed narrows the
		// findings and never the counts, so the count lines stand whole.
		expect(changed.lines.slice(1, 9)).toEqual(plain.lines.slice(1, 9));
		// The exit code states the status line: OK is 0, FAILED is non-zero.
		if (plain.lines[0].startsWith("audit OK")) {
			expect(plain.code).toBe(0);
		} else {
			expect(plain.code).toBe(1);
		}
	});
});
