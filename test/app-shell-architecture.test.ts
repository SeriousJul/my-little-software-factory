/**
 * The App shell's boot record is total (issue #366, ADR 0129).
 *
 * The shell used to start from a bag of ten fields, nine of them optional,
 * and the absence checks and the defaults it filled in from its own
 * implementation were a second control plane: a plane with no state file
 * read its Ticket list from an in-memory projection, ran no loops, and
 * handed back no teardown handle. The retirement lands the boot record
 * total - every field the plane needs is required - and this file refuses
 * the shapes that would rebuild the second plane: an absence check on a
 * boot field the interface makes required, a default that fills one, and
 * the retired slot names.
 *
 * The rule is a declared dependency rule, not a behavior test: what a
 * booted plane shows is checked by the frame suites, one per surface, on
 * a real state file, and the harness's own suite pins that a boot without
 * a named plane lands on the Seeded plane, so the projection plane cannot
 * return as a default. This file refuses the interface the behavior would
 * stand on, the way the herdr-view check refuses the shape a new screen
 * would take to re-add the view move.
 *
 * Stated limits, the way the other checks state theirs:
 *
 * - The absence and default scans read `props.<field>` references in the
 *   shell module. A stage that destructures a field under another name and
 *   checks that name is not read here; the frame seam owns that shape.
 * - The interface read brace-matches the `AppProps` body in the shell
 *   module. A field the interface gained through an intersection or a type
 *   alias is not counted, and the count would stand quiet.
 * - The retired-name scan reads the token `initialTickets` wherever it
 *   stands in `src/`; an import of it under an alias passes. The
 *   `pollIntervalMs` name stands in the observation module's own options,
 *   which are a sibling spec's interface, so its refusal is at the plane's
 *   interface, the `AppProps` body, not at the token.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sourceFiles } from "./static-checks.ts";

const APP_SHELL = "src/components/app.ts";
const sources = sourceFiles("src");
const shell = readFileSync(APP_SHELL, "utf8");

/** The nine fields the boot record names, in the order the interface holds them. */
const EXPECTED_FIELDS = [
	"config",
	"runner",
	"home",
	"configPath",
	"state",
	"sources",
	"logger",
	"loopPolicy",
	"onReady",
];

/** The boot field names the interface retired. */
const RETIRED_SLOTS = ["initialTickets", "pollIntervalMs"];

/** The body of the named exported interface, brace-matched. */
function interfaceBody(source: string, name: string): string {
	const open = source.indexOf(`export interface ${name} {`);
	if (open === -1) throw new Error(`the interface ${name} is not in ${APP_SHELL}`);
	const start = source.indexOf("{", open);
	let depth = 0;
	for (let i = start; i < source.length; i += 1) {
		if (source[i] === "{") depth += 1;
		if (source[i] === "}") depth -= 1;
		if (depth === 0) return source.slice(start + 1, i);
	}
	throw new Error(`the interface ${name} holds no closing brace`);
}

/**
 * The fields one interface body names, in order, each with whether the
 * body marks it optional. The body's comments stand aside: they name the
 * fields too, and the count reads the declarations only.
 */
function fieldsOf(body: string): { name: string; optional: boolean }[] {
	const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
	return [...stripped.matchAll(/^[\t]*(\w+)(\?)?\s*:/gm)].map((match) => ({
		name: match[1],
		optional: match[2] === "?",
	}));
}

describe("the App shell's boot record is total", () => {
	test("the scan reads the App shell module", () => {
		// A check that scans nothing passes forever. The module the rule
		// stands on must be in the set the scan reads.
		expect(sources, `${APP_SHELL} must be in the scanned set`).toContain(APP_SHELL);
	});

	test("the record holds exactly the nine required fields", () => {
		const fields = fieldsOf(interfaceBody(shell, "AppProps"));
		// The field count is a number the check reads (user story 27): the
		// interface cannot grow an optional slot, or any slot, without the
		// decision standing here.
		expect(fields, "the boot record's field count").toHaveLength(9);
		expect(
			fields.map((field) => field.name),
			"the boot record's field names, in the interface's order",
		).toEqual(EXPECTED_FIELDS);
	});

	test("no field of the record is optional", () => {
		const fields = fieldsOf(interfaceBody(shell, "AppProps"));
		const optional = fields.filter((field) => field.optional);
		expect(
			optional.map((field) => field.name),
			"an optional field is an absence the interface says maybe on",
		).toEqual([]);
	});

	test("no retired slot name stands in the record", () => {
		const fields = fieldsOf(interfaceBody(shell, "AppProps"));
		const offenders = fields
			.map((field) => field.name)
			.filter((name) => RETIRED_SLOTS.includes(name));
		expect(offenders).toEqual([]);
	});

	test("the shell checks no boot field for absence", () => {
		// The 63 absence checks the old interface paid for (issue #366) are
		// the shape a rebuilt second plane would take: a required field read
		// as maybe-absent. The scan is scoped to the `props.` reference, the
		// stated limit in the file's note.
		const offenders: string[] = [];
		for (const field of EXPECTED_FIELDS) {
			for (const pattern of [
				`props.${field}\\b[^\\n;]*=== undefined`,
				`props.${field}\\b[^\\n;]*!== undefined`,
				`props.${field}\\?\\.`,
			]) {
				if (new RegExp(pattern, "u").test(shell)) offenders.push(`${field}: ${pattern}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the shell fills no boot field with its own default", () => {
		// A `??` default is the absence check the interface would have to
		// carry: the field reads as maybe-absent before it is filled. The
		// four defaults the old shell built - the child-process runner, the
		// process home, the default config path, the empty source set - were
		// this shape on their own fields.
		const offenders: string[] = [];
		for (const field of EXPECTED_FIELDS) {
			if (new RegExp(`props\\.${field}\\b[^\\n;]*\\?\\?`, "u").test(shell)) offenders.push(field);
		}
		expect(offenders).toEqual([]);
	});

	test("no source names the retired projection slot", () => {
		// The in-memory projection slot left the interface with the
		// projection plane. Its name anywhere in the plane's sources is the
		// slot standing back in the tree.
		const offenders = sources.filter((file) =>
			/\binitialTickets\b/u.test(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
	});

	test("the field scan reads the interface it refuses", () => {
		// A scan whose patterns match nothing is worse than no scan. The
		// field read, the optionality read, and the absence and default
		// patterns each take a shape they must catch, so a quiet edit to one
		// cannot pass unnoticed.
		const body = interfaceBody(shell, "AppProps");
		expect(fieldsOf(body).map((field) => field.name)).toEqual(EXPECTED_FIELDS);
		expect(
			fieldsOf(
				"config: FactoryConfig;\nrunner?: CommandRunner;\ninitialTickets: readonly Ticket[];",
			).map((field) => field.name),
		).toEqual(["config", "runner", "initialTickets"]);
		expect(fieldsOf("runner?: CommandRunner;")[0].optional).toBe(true);
		const absent = "state: props.state === undefined ? null : props.state;";
		expect(/props\.state\b[^\n;]*=== undefined/u.test(absent)).toBe(true);
		const filled = "runner: props.runner ?? buildRunner();";
		expect(/props\.runner\b[^\n;]*\?\?/u.test(filled)).toBe(true);
	});
});
