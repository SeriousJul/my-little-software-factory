/**
 * The control plane's write-back to the operator's config file (ADR 0103).
 *
 * The plane owns two regions of the operator's file: the `[repos]` table and
 * the `[[sources]]` blocks. A write-back edits those regions in place - it
 * writes the mapping key it holds and appends the source blocks it registers -
 * and leaves every other byte, the operator's comments and blank-line layout
 * included, where the operator put it. It never deletes a line the plane did
 * not write. The one line it can drop is its own: a top-level `sources = []`
 * key, the form the plane's own serializer used to write an empty source list,
 * because a `[[sources]]` block cannot stand beside a key of the same name.
 *
 * The edit is checked before it lands: the patched text must parse, must
 * validate, and must carry every mapping and every source the plane holds. A
 * file the checker will not vouch for - a region the scanner cannot read, a
 * source block with no name, a patch that does not carry what the plane wrote
 * - falls back to the full rewrite the plane used before, and the fallback is
 * named on the Message line so the operator learns the comments did not
 * survive.
 *
 * What the line scan reads, and what it does not. It reads table headers,
 * single-line key assignments, and the string forms a config file carries: a
 * basic string with its escapes, a literal string, and the multiline form of
 * each. It does not read a value that spans lines (a multiline array, an
 * inline table), a dotted key, or any other TOML form the plane's own
 * serializer does not write. Such a line is the operator's own, and the edit
 * leaves it alone; what keeps the write honest is the verify step, which
 * refuses a patched text that does not carry what the plane holds. A file
 * whose lines end CRLF is edited the same way: every line the plane writes
 * carries the file's own line ending.
 *
 * One window this design does not close, stated so the next contributor does
 * not read the verify step as a lock: the patch is built and checked in
 * memory, and the file can change again between the check and the rename. The
 * patch carries only the two regions the plane owns, so the most a change lost
 * to that window can do is overwrite an operator's edit of a line the plane
 * itself writes.
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
	} catch (error) {
		// Only a file that is not there is a file to create. A read that failed
		// for another reason - no permission, a directory where the file stands -
		// is not "nothing of the operator's stands here to lose", and the caller
		// that asked for the write hears it instead of a fresh file landing.
		if (!isMissingFile(error)) throw error;
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

function isMissingFile(error: unknown): boolean {
	return (error as { code?: string } | null)?.code === "ENOENT";
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
	/** The line without its trailing carriage return, what every match reads. */
	body: string;
	/** The table this line opens, or null for a body line. */
	header: TomlHeader | null;
	/** The line begins inside a multiline string an earlier line opened. */
	startsInString: boolean;
	/** The line ends inside a multiline string it opened itself. */
	opensString: boolean;
	/** Where a comment starts on this line, or null when it holds none. */
	commentAt: number | null;
}

/** A table's span in the file: its header line up to the next header line. */
interface Region {
	start: number;
	end: number;
}

/** The lines one section edit wants changed, and the ending the file uses. */
interface SectionEdit {
	/** The carriage return every line the plane writes carries, "" for a LF file. */
	eol: string;
	/** Line index to the new text of that line. */
	replace: Map<number, string>;
	/** Line indexes the edit drops. Only the plane's own forms land here. */
	remove: Set<number>;
	/** New lines to emit after one line the file already holds. */
	insertAfter: Map<number, string[]>;
	/** New lines to append at the end of the file. */
	tail: string[];
}

/**
 * Rewrite the `[repos]` table and the `[[sources]]` blocks in the operator's
 * text, or null when the text is not one this edit can be trusted on.
 */
function patchOwnedSections(text: string, updated: FactoryConfig): string | null {
	const lines = text.split("\n");
	const edit: SectionEdit = {
		eol: text.includes("\r\n") ? "\r" : "",
		replace: new Map(),
		remove: new Set(),
		insertAfter: new Map(),
		tail: [],
	};
	const scanned = scanToml(lines);
	if (!editReposRegion(scanned, updated, edit)) return null;
	if (!editSourcesRegion(scanned, updated, edit)) return null;

	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!edit.remove.has(i)) {
			const replacement = edit.replace.get(i);
			out.push(replacement === undefined ? lines[i] : replacement);
		}
		const inserted = edit.insertAfter.get(i);
		if (inserted !== undefined) out.push(...inserted);
	}
	if (edit.tail.length > 0) {
		// The file ended with a newline; the appended lines keep that ending so
		// the operator's last line is still a line.
		out.push(...edit.tail);
		if (lines[lines.length - 1] === "") out.push("");
	}
	return out.join("\n");
}

/**
 * The `[repos]` table. A key the plane holds is written on the line that
 * already names it, or appended inside the table. A key the file names and the
 * plane does not is the operator's own line and stays. A comment the operator
 * wrote beside a key the plane rewrites keeps standing on that line.
 *
 * False means the file is not one this edit can be trusted on.
 */
function editReposRegion(
	scanned: ScannedLine[],
	updated: FactoryConfig,
	edit: SectionEdit,
): boolean {
	const entries = Object.entries(updated.repos);
	if (entries.length === 0) return true;
	const regions = regionsOf(scanned, "repos", false);
	if (regions.length > 1) return false;
	if (regions.length === 0) {
		edit.tail.push(
			"",
			"[repos]",
			...entries.map(([key, value]) => assignmentLine(edit, key, value)),
		);
		return true;
	}
	const region = regions[0];
	const written = new Set<string>();
	for (let i = region.start + 1; i < region.end; i++) {
		const key = assignmentKey(scanned[i].body);
		if (key === null) continue;
		const value = updated.repos[key];
		// A key the plane does not hold is one the operator wrote by hand
		// since the plane read the file. The plane owns its own keys, not theirs.
		if (value === undefined) continue;
		written.add(key);
		if (assignmentValue(scanned[i].body) === value) continue;
		const indent = /^\s*/.exec(scanned[i].body)?.[0] ?? "";
		// The line's own comment is the operator's prose about the value, and it
		// survives the plane's new value (ADR 0103).
		const comment = trailingComment(scanned[i]);
		const cr = scanned[i].text.endsWith("\r") ? "\r" : "";
		edit.replace.set(i, `${indent}${tomlKey(key)} = ${tomlString(value)}${comment ?? ""}${cr}`);
	}
	const missing = entries.filter(([key]) => !written.has(key));
	if (missing.length > 0) {
		insertAt(
			edit,
			lastEditableLine(scanned, region),
			missing.map(([key, value]) => assignmentLine(edit, key, value)),
		);
	}
	return true;
}

/** A `key = value` line the plane writes, in the file's own line ending. */
function assignmentLine(edit: SectionEdit, key: string, value: string): string {
	return `${tomlKey(key)} = ${tomlString(value)}${edit.eol}`;
}

/**
 * The `[[sources]]` blocks. A block the file already names by source name is
 * left byte-for-byte; a source the plane holds that no block names is appended
 * after the last block the file holds.
 *
 * False means the file is not one this edit can be trusted on.
 */
function editSourcesRegion(
	scanned: ScannedLine[],
	updated: FactoryConfig,
	edit: SectionEdit,
): boolean {
	// A `[sources]` table is not the array-of-tables shape the plane writes, and
	// an edit beside it could land inside it.
	if (
		scanned.some((row) => row.header !== null && row.header.name === "sources" && !row.header.array)
	) {
		return false;
	}
	const regions = regionsOf(scanned, "sources", true);
	const named = new Set<string>();
	for (const region of regions) {
		const name = sourceNameOf(scanned, region);
		// A block the scanner cannot name is a block the coverage rule cannot
		// read, so the whole edit is refused rather than guessed at.
		if (name === null) return false;
		named.add(name);
	}
	const missing = updated.sources.filter((source) => !named.has(source.name));
	if (missing.length === 0) return true;
	// The serializer ends its text with a newline; the last element the split
	// yields is empty, so the block is every line before it.
	const block = sourcesToToml(missing)
		.split("\n")
		.slice(0, -1)
		.map((row) => `${row}${edit.eol}`);
	// The plane's own empty-sources form. `sources = []` is a key, and a
	// `[[sources]]` block cannot stand beside a key of the same name: the patch
	// would not parse and the checker would refuse it. The key is the plane's
	// own writing, so the edit drops it. The blocks go at the end of the file,
	// never where the key stood: a top-level key line sits above every table,
	// and a table opened in the middle of them buries the keys that follow.
	const empty = emptySourcesKeyLine(scanned);
	if (empty >= 0) edit.remove.add(empty);
	if (regions.length === 0) {
		edit.tail.push("", ...block);
		return true;
	}
	insertAt(edit, lastEditableLine(scanned, regions[regions.length - 1]), ["", ...block]);
	return true;
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
		const row = scanned[i];
		if (row.body.trim() === "") continue;
		if (row.opensString) continue;
		// A line that is nothing but a comment is skipped: it usually belongs to
		// the section below, and the new line must not land between it and that
		// section. A comment riding on a key line belongs to that key, and the new
		// line goes after the whole line.
		if (
			!row.startsInString &&
			row.commentAt !== null &&
			row.body.slice(0, row.commentAt).trim() === ""
		) {
			continue;
		}
		return i;
	}
	return region.start;
}

function insertAt(edit: SectionEdit, at: number, lines: string[]): void {
	const held = edit.insertAfter.get(at);
	if (held === undefined) edit.insertAfter.set(at, lines);
	else edit.insertAfter.set(at, [...held, ...lines]);
}

/**
 * The index of a top-level `sources = []` line - the empty source list the
 * plane's own serializer used to write - or -1 when the file holds none. Only
 * the lines before the first table header count: past one, `sources` is a key
 * of somebody else's table.
 */
function emptySourcesKeyLine(scanned: ScannedLine[]): number {
	for (let i = 0; i < scanned.length; i++) {
		if (scanned[i].header !== null) return -1;
		if (scanned[i].startsInString) continue;
		if (/^\s*sources\s*=\s*\[\s*\]\s*$/u.test(scanned[i].body)) return i;
	}
	return -1;
}

/** The `name` of the source a `[[sources]]` region holds, or null when it names none. */
function sourceNameOf(scanned: ScannedLine[], region: Region): string | null {
	for (let i = region.start + 1; i < region.end; i++) {
		if (scanned[i].header !== null) break;
		if (assignmentKey(scanned[i].body) !== "name") continue;
		const value = assignmentValue(scanned[i].body);
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
		const body = text.endsWith("\r") ? text.slice(0, -1) : text;
		let from = 0;
		const startsInString = open !== null;
		if (open !== null) {
			const close = findClose(body, 0, open, true);
			if (close === null) {
				out.push({
					text,
					body,
					header: null,
					startsInString,
					opensString: true,
					commentAt: null,
				});
				continue;
			}
			open = null;
			from = close + 3;
		}
		const header = headerAt(body, from);
		if (header !== null) {
			out.push({ text, body, header, startsInString, opensString: false, commentAt: null });
			continue;
		}
		let i = from;
		let opensString = false;
		let commentAt: number | null = null;
		while (i < body.length) {
			const ch = body[i];
			if (ch === "#") {
				commentAt = i;
				break;
			}
			if (ch === '"' || ch === "'") {
				if (body.startsWith(ch.repeat(3), i)) {
					const close = findClose(body, i + 3, ch, true);
					if (close === null) {
						open = ch;
						opensString = true;
						break;
					}
					i = close + 3;
					continue;
				}
				const close = findClose(body, i + 1, ch, false);
				if (close === null) break;
				i = close + 1;
				continue;
			}
			i += 1;
		}
		out.push({ text, body, header: null, startsInString, opensString, commentAt });
	}
	return out;
}

function headerAt(text: string, from: number): TomlHeader | null {
	const rest = text.slice(from);
	const array = /^\s*\[\[\s*([^[\]]+?)\s*\]\]\s*(?:#.*)?$/u.exec(rest);
	if (array !== null) return { name: array[1].trim(), array: true };
	const table = /^\s*\[([^[\]]+?)\]\s*(?:#.*)?$/u.exec(rest);
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

const ASSIGNMENT = /^\s*("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/u;

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
	return unquote(match[2].replace(/\s+#.*$/u, "").trim());
}

/**
 * The comment an operator wrote beside a line, from its `#` and including the
 * space before it, or null when the line holds none. A `#` inside a string is
 * part of the value, not a comment.
 */
function trailingComment(line: ScannedLine): string | null {
	if (line.commentAt === null) return null;
	let at = line.commentAt;
	while (at > 0 && /[ \t]/.test(line.body[at - 1])) at -= 1;
	return line.body.slice(at);
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
	if (/^[A-Za-z0-9_.-]+$/u.test(text)) return text;
	return null;
}

/** A key in the form the plane writes it: quoted when it is not a bare key. */
function tomlKey(key: string): string {
	return /^[A-Za-z0-9_-]+$/u.test(key) ? key : tomlString(key);
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
