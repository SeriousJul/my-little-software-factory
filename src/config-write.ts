/**
 * The control plane's write-back to the operator's config file (ADR 0103).
 *
 * The plane owns two regions of the operator's file: the `[repos]` table and
 * the `[[sources]]` blocks. A write-back edits those regions in place - it
 * writes the mapping key it holds and appends the source blocks it registers -
 * and leaves every other byte, the operator's comments and blank-line layout
 * included, where the operator put it. It never deletes a line the plane did
 * not write.
 *
 * The edit is checked before it lands: the patched text must parse, must
 * validate, and must carry every mapping and every source the plane holds. A
 * file the checker will not vouch for - a region the scanner cannot read, a
 * source block with no name, a patch that does not carry what the plane wrote
 * - falls back to the full rewrite the plane used before, and the fallback is
 * named on the Message line so the operator learns the comments did not
 * survive.
 */
import { readFile } from "node:fs/promises";
import { parse } from "smol-toml";

import {
	configToToml,
	containsLiteralToken,
	type FactoryConfig,
	sourcesToToml,
	validateConfig,
	writeConfigText,
} from "./config.ts";

/** How the operator's config file landed on disk. */
export type ConfigWriteMode = "sections" | "rewrite" | "created" | "unchanged";

export interface ConfigWriteFact {
	/**
	 * `sections` edited only what the plane owns, `rewrite` replaced a file the
	 * operator already had, `created` wrote a file where none stood, and
	 * `unchanged` wrote nothing.
	 */
	mode: ConfigWriteMode;
	/** The config file the write landed on. */
	path: string;
}

/**
 * Write the config the plane now holds to the operator's file.
 *
 * One entry point for every write-back the plane does - the Consultation's
 * repository mapping and the Repository init's sources alike - so both stand
 * under the same rule and one Message line wording (ADR 0103).
 */
export async function writeConfigFile(
	path: string,
	updated: FactoryConfig,
): Promise<ConfigWriteFact> {
	let original: string;
	try {
		original = await readFile(path, "utf8");
	} catch {
		// No file to edit: the write creates it, and nothing of the operator's
		// stands in it to lose.
		await writeConfigText(path, configToToml(updated), containsLiteralToken(updated));
		return { mode: "created", path };
	}
	const patched = patchOwnedSections(original, updated);
	if (patched !== null) {
		const carried = verifyPatch(patched, updated);
		if (carried !== null) {
			// Nothing the plane holds differs from what the file already says:
			// the operator's file is left alone, byte and timestamp alike.
			if (patched === original) return { mode: "unchanged", path };
			await writeConfigText(path, patched, containsLiteralToken(carried));
			return { mode: "sections", path };
		}
	}
	await writeConfigText(path, configToToml(updated), containsLiteralToken(updated));
	return { mode: "rewrite", path };
}

/**
 * The Message line one config write-back leaves, for every caller that does
 * one. `written` names what the plane wrote in its own words; the wording of
 * where it landed, and of a full rewrite, is the same for both write-backs.
 * An empty string means there is nothing to say: the file was not touched.
 */
export function configWriteLine(fact: ConfigWriteFact, written: string): string {
	if (fact.mode === "unchanged") return "";
	if (fact.mode !== "rewrite") return `${written} in ${fact.path}`;
	return (
		`${written} in ${fact.path}; ` +
		"the whole config file was rewritten, and the comments in it did not survive"
	);
}

// ---------------------------------------------------------------------------
// The section edit
// ---------------------------------------------------------------------------

interface TomlHeader {
	name: string;
	array: boolean;
}

interface ScannedLine {
	text: string;
	/** The table this line opens, or null for a body line. */
	header: TomlHeader | null;
	/** The line begins inside a multiline string an earlier line opened. */
	startsInString: boolean;
	/** The line ends inside a multiline string it opened itself. */
	opensString: boolean;
}

/** A table's span in the file: its header line up to the next header line. */
interface Region {
	start: number;
	end: number;
}

/**
 * Rewrite the `[repos]` table and the `[[sources]]` blocks in the operator's
 * text, or null when the text is not one this edit can be trusted on.
 */
function patchOwnedSections(text: string, updated: FactoryConfig): string | null {
	const lines = text.split("\n");
	const scanned = scanToml(lines);
	const replace = new Map<number, string>();
	const insertAfter = new Map<number, string[]>();
	const tail: string[] = [];

	const repos = editReposRegion(scanned, updated, replace, insertAfter);
	if (repos !== null) tail.push(...repos);

	const sources = editSourcesRegion(scanned, updated, insertAfter);
	if (sources !== null) tail.push(...sources);

	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const replacement = replace.get(i);
		out.push(replacement === undefined ? lines[i] : replacement);
		const inserted = insertAfter.get(i);
		if (inserted !== undefined) out.push(...inserted);
	}
	out.push(...tail);
	return out.join("\n");
}

/**
 * The `[repos]` table. A key the plane holds is written on the line that
 * already names it, or appended inside the table. A key the file names and the
 * plane does not is the operator's own line and stays.
 *
 * The returned lines are the table to append when the file holds none.
 */
function editReposRegion(
	scanned: ScannedLine[],
	updated: FactoryConfig,
	replace: Map<number, string>,
	insertAfter: Map<number, string[]>,
): string[] | null {
	const entries = Object.entries(updated.repos);
	if (entries.length === 0) return [];
	const regions = regionsOf(scanned, "repos", false);
	if (regions.length > 1) return null;
	if (regions.length === 0) {
		return [
			"",
			"[repos]",
			...entries.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`),
		];
	}
	const region = regions[0];
	const written = new Set<string>();
	for (let i = region.start + 1; i < region.end; i++) {
		const key = assignmentKey(scanned[i].text);
		if (key === null) continue;
		const value = updated.repos[key];
		// A key the plane does not hold is one the operator wrote by hand
		// since the plane read the file. The plane owns its own keys, not theirs.
		if (value === undefined) continue;
		written.add(key);
		if (assignmentValue(scanned[i].text) === value) continue;
		const indent = /^\s*/.exec(scanned[i].text)?.[0] ?? "";
		replace.set(i, `${indent}${tomlKey(key)} = ${tomlString(value)}`);
	}
	const missing = entries.filter(([key]) => !written.has(key));
	if (missing.length > 0) {
		insertAt(
			insertAfter,
			lastEditableLine(scanned, region),
			missing.map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`),
		);
	}
	return [];
}

/**
 * The `[[sources]]` blocks. A block the file already names by source name is
 * left byte-for-byte; a source the plane holds that no block names is appended
 * after the last block the file holds.
 *
 * The returned lines are the blocks to append when the file holds none.
 */
function editSourcesRegion(
	scanned: ScannedLine[],
	updated: FactoryConfig,
	insertAfter: Map<number, string[]>,
): string[] | null {
	// A `[sources]` table is not the array-of-tables shape the plane writes, and
	// an edit beside it could land inside it.
	if (
		scanned.some(
			(line) => line.header !== null && line.header.name === "sources" && !line.header.array,
		)
	) {
		return null;
	}
	const regions = regionsOf(scanned, "sources", true);
	const named = new Set<string>();
	for (const region of regions) {
		const name = sourceNameOf(scanned, region);
		// A block the scanner cannot name is a block the coverage rule cannot
		// read, so the whole edit is refused rather than guessed at.
		if (name === null) return null;
		named.add(name);
	}
	const missing = updated.sources.filter((source) => !named.has(source.name));
	if (missing.length === 0) return [];
	const block = sourcesToToml(missing).split("\n");
	block.pop();
	if (regions.length === 0) return ["", ...block];
	insertAt(insertAfter, lastEditableLine(scanned, regions[regions.length - 1]), ["", ...block]);
	return [];
}

/**
 * The last line of a region a new line can follow.
 *
 * A blank line, a comment line, and a line that ends inside a multiline string
 * are all skipped: the new line goes after the region's own last key, so a
 * comment the operator wrote for the section below keeps standing over the
 * section it describes.
 */
function lastEditableLine(scanned: ScannedLine[], region: Region): number {
	for (let i = region.end - 1; i >= region.start; i--) {
		const line = scanned[i];
		if (line.text.trim() === "") continue;
		if (line.opensString) continue;
		if (!line.startsInString && line.text.trim().startsWith("#")) continue;
		return i;
	}
	return region.start;
}

function insertAt(insertAfter: Map<number, string[]>, at: number, lines: string[]): void {
	const held = insertAfter.get(at);
	if (held === undefined) insertAfter.set(at, lines);
	else insertAfter.set(at, [...held, ...lines]);
}

/** The `name` of the source a `[[sources]]` region holds, or null when it names none. */
function sourceNameOf(scanned: ScannedLine[], region: Region): string | null {
	for (let i = region.start + 1; i < region.end; i++) {
		if (scanned[i].header !== null) break;
		if (assignmentKey(scanned[i].text) !== "name") continue;
		const value = assignmentValue(scanned[i].text);
		return value === null ? "" : value;
	}
	return null;
}

/**
 * The patched file must carry what the plane wrote. The check reads the patched
 * text the way startup reads it, so a patch that misreads the file cannot land.
 * The returned config is the one the file now carries, and it decides the file
 * mode the write asks for.
 */
function verifyPatch(patched: string, updated: FactoryConfig): FactoryConfig | null {
	let carried: FactoryConfig;
	try {
		carried = validateConfig(parse(patched));
	} catch {
		return null;
	}
	for (const [key, value] of Object.entries(updated.repos)) {
		if (carried.repos[key] !== value) return null;
	}
	for (const source of updated.sources) {
		const held = carried.sources.find((candidate) => candidate.name === source.name);
		if (held === undefined) return null;
		// The comparison is the text the plane would write for each side, so a
		// field the loader fills in by default is not mistaken for a change the
		// operator made.
		if (sourcesToToml([held]) !== sourcesToToml([source])) return null;
	}
	return carried;
}

// ---------------------------------------------------------------------------
// The TOML line scan
// ---------------------------------------------------------------------------

/**
 * Classify each line as a table header or a body line.
 *
 * The scan tracks the multiline strings a config carries - every task type's
 * prompt - so a line of prose inside a template is never mistaken for a table
 * header. A patch this scan gets wrong still has to pass the verify step, so
 * the worst a wrong scan can do is send the write back to the full rewrite.
 */
function scanToml(lines: string[]): ScannedLine[] {
	const out: ScannedLine[] = [];
	let open: string | null = null;
	for (const text of lines) {
		let from = 0;
		const startsInString = open !== null;
		if (open !== null) {
			const close = findClose(text, 0, open, true);
			if (close === null) {
				out.push({ text, header: null, startsInString, opensString: true });
				continue;
			}
			open = null;
			from = close + 3;
		}
		const header = headerAt(text, from);
		if (header !== null) {
			out.push({ text, header, startsInString, opensString: false });
			continue;
		}
		let i = from;
		let opensString = false;
		while (i < text.length) {
			const ch = text[i];
			if (ch === "#") break;
			if (ch === '"' || ch === "'") {
				if (text.startsWith(ch.repeat(3), i)) {
					const close = findClose(text, i + 3, ch, true);
					if (close === null) {
						open = ch;
						opensString = true;
						break;
					}
					i = close + 3;
					continue;
				}
				const close = findClose(text, i + 1, ch, false);
				if (close === null) break;
				i = close + 1;
				continue;
			}
			i += 1;
		}
		out.push({ text, header: null, startsInString, opensString });
	}
	return out;
}

function headerAt(text: string, from: number): TomlHeader | null {
	const rest = text.slice(from);
	const array = /^\s*\[\[\s*([^[\]]+?)\s*\]\]\s*(?:#.*)?$/.exec(rest);
	if (array !== null) return { name: array[1].trim(), array: true };
	const table = /^\s*\[([^[\]]+?)\]\s*(?:#.*)?$/.exec(rest);
	if (table !== null) return { name: table[1].trim(), array: false };
	return null;
}

/** The index of the delimiter that closes the string, or null when the line holds none. */
function findClose(text: string, from: number, quote: string, multiline: boolean): number | null {
	if (multiline) {
		const delimiter = quote.repeat(3);
		let i = from;
		while (i < text.length) {
			if (quote === '"' && text[i] === "\\") {
				i += 2;
				continue;
			}
			if (text.startsWith(delimiter, i)) return i;
			i += 1;
		}
		return null;
	}
	let i = from;
	while (i < text.length) {
		if (quote === '"' && text[i] === "\\") {
			i += 2;
			continue;
		}
		if (text[i] === quote) return i;
		i += 1;
	}
	return null;
}

/**
 * The regions one table name holds: each header line up to the next header
 * line that is not its own sub-table. An array-of-tables holds one region per
 * entry.
 */
function regionsOf(scanned: ScannedLine[], name: string, array: boolean): Region[] {
	const headers: number[] = [];
	for (let i = 0; i < scanned.length; i++) {
		const header = scanned[i].header;
		if (header !== null) headers.push(i);
	}
	const out: Region[] = [];
	for (let h = 0; h < headers.length; h++) {
		const at = headers[h];
		const header = scanned[at].header;
		if (header === null || header.name !== name || header.array !== array) continue;
		let end = scanned.length;
		for (let j = h + 1; j < headers.length; j++) {
			const next = scanned[headers[j]].header;
			if (next?.name.startsWith(`${name}.`)) continue;
			end = headers[j];
			break;
		}
		out.push({ start: at, end });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Key and value text
// ---------------------------------------------------------------------------

const ASSIGNMENT = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/;

/** The key a body line assigns, decoded, or null when the line assigns none. */
function assignmentKey(text: string): string | null {
	const match = ASSIGNMENT.exec(text);
	if (match === null) return null;
	return unquote(match[1]);
}

/** The value a body line assigns, decoded, or null when the form is not a plain string. */
function assignmentValue(text: string): string | null {
	const match = ASSIGNMENT.exec(text);
	if (match === null) return null;
	return unquote(match[2].replace(/\s+#.*$/, "").trim());
}

function unquote(text: string): string | null {
	if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
		let out = "";
		for (let i = 1; i < text.length - 1; i++) {
			const ch = text[i];
			if (ch !== "\\") {
				out += ch;
				continue;
			}
			const next = text[i + 1];
			if (next === undefined) return null;
			if (next === "n") out += "\n";
			else if (next === "t") out += "\t";
			else if (next === "r") out += "\r";
			else if (next === "u") {
				const hex = text.slice(i + 2, i + 6);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
				out += String.fromCodePoint(Number.parseInt(hex, 16));
				i += 4;
			} else out += next;
			i += 1;
		}
		return out;
	}
	if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
	if (/^[A-Za-z0-9_.-]+$/.test(text)) return text;
	return null;
}

/** A key in the form the plane writes it: quoted when it is not a bare key. */
function tomlKey(key: string): string {
	return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** A basic TOML string, in the form the plane writes it. */
function tomlString(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "\\") out += "\\\\";
		else if (ch === '"') out += '\\"';
		else if (ch === "\n") out += "\\n";
		else if (ch === "\t") out += "\\t";
		else if (ch === "\r") out += "\\r";
		else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
		else out += ch;
	}
	return `"${out}"`;
}
