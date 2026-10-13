/**
 * The typescript package the Stryker campaign host resolves, and nothing more
 * (issue #377).
 *
 * Stryker core 10.0.0's ts-config preprocessor imports the bare specifier
 * `typescript` from its own package and reads exactly one function from it:
 * `parseConfigFileTextToJson`, the parse it runs on the sandbox copy's
 * `tsconfig.json` before it rewrites the file's `extends`, `references`,
 * `include`, `exclude`, and `files` paths for the sandbox. The typescript this
 * repository declares - 7.0.2, the native compiler line `bun run typecheck`
 * runs - exposes no compiler API at all, so a host that resolves the
 * top-level package dies at the campaign's first step with `ts.parseConfigFileTextToJson is not a function`,
 * and no campaign, scoped or full, can start. Scoping cannot avoid it: the
 * preprocessor runs before the scope is applied.
 *
 * This package is that one function, vendored. `scripts/mutate.sh` stages it
 * at `node_modules/@stryker-mutator/core/node_modules/typescript`, where the
 * preprocessor's import finds it before the top-level 7.0.2. Nothing else in
 * the host resolves it: bare-specifier resolution is per package, so the
 * instrumenter and the Bun runner plugin keep resolving the top-level line
 * exactly as before. The top-level declaration is untouched: `bun run
 * typecheck` and the quality audit still run the native tsc, and the campaign
 * measures the same suite, scope, and thresholds ADR 0055 fixed.
 *
 * The parse stands on plain JSON plus the two JSONC extensions the real
 * `parseConfigFileTextToJson` tolerates: comments and trailing commas. It
 * answers the shape the preprocessor reads - `{ config, error }`, where
 * `config` is the parsed object and `error` names the first fault - and a
 * syntactically broken text answers `config: undefined`, the same answer the
 * preprocessor gives a file it cannot read. The surface stays that small on
 * purpose: the preprocessor is the only `typescript` reader in the host
 * process, and a Stryker release that reads more of the API must widen this
 * shim and its tests, not let the host fall back to the native line that
 * carries no API.
 */

/** The one error this shim reports: a position into the tsconfig text. */
class JsoncError extends Error {}

/**
 * The cursor the parse walks: one position into the text, one method per JSON
 * form. The methods are small so the parser stays a set of cases, not a
 * state machine.
 */
class JsoncParser {
	constructor(text) {
		this.text = text;
		this.pos = 0;
	}

	fail(message) {
		throw new JsoncError(`${message} at position ${this.pos} of the tsconfig text`);
	}

	/** Skip the forms that carry no value: whitespace, line comments, blocks. */
	skipIgnored() {
		for (;;) {
			const ch = this.text[this.pos];
			if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
				this.pos += 1;
			} else if (this.startsComment()) {
				this.skipComment();
			} else {
				return;
			}
		}
	}

	startsComment() {
		return this.text[this.pos] === "/" && (this.peek(1) === "/" || this.peek(1) === "*");
	}

	/**
	 * Skip one comment: the cursor stands on the opening `/`, and the second
	 * character names the kind. A line comment runs to its newline; a block to
	 * its close, or fails when the text ends first.
	 */
	skipComment() {
		const kind = this.peek(1);
		this.pos += 2;
		if (kind === "/") {
			while (this.pos < this.text.length && this.text[this.pos] !== "\n") this.pos += 1;
		} else {
			const end = this.text.indexOf("*/", this.pos);
			if (end === -1) this.fail("unterminated block comment");
			this.pos = end + 2;
		}
	}

	peek(n) {
		return this.text[this.pos + n];
	}

	digits() {
		while (/[0-9]/.test(this.text[this.pos] ?? "")) this.pos += 1;
	}

	parseString() {
		this.pos += 1;
		let out = "";
		for (;;) {
			const ch = this.text[this.pos];
			if (ch === undefined) this.fail("unterminated string");
			if (ch === '"') {
				this.pos += 1;
				return out;
			}
			if (ch !== "\\") {
				out += ch;
				this.pos += 1;
				continue;
			}
			out += this.parseEscape();
		}
	}

	/**
	 * One escape after a backslash: the backslash stands at this.pos. Advances
	 * past the escape and answers the character it names.
	 */
	parseEscape() {
		const esc = this.text[this.pos + 1];
		this.pos += 2;
		if (esc === '"') return '"';
		if (esc === "\\") return "\\";
		if (esc === "/") return "/";
		if (esc === "n") return "\n";
		if (esc === "t") return "\t";
		if (esc === "r") return "\r";
		if (esc === "b") return "\b";
		if (esc === "f") return "\f";
		if (esc === "u") {
			const hex = this.text.slice(this.pos, this.pos + 4);
			if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid \\u escape");
			this.pos += 4;
			return String.fromCharCode(parseInt(hex, 16));
		}
		this.fail("invalid escape");
	}

	parseNumber() {
		const start = this.pos;
		if (this.text[this.pos] === "-") this.pos += 1;
		this.digitRun();
		if (this.text[this.pos] === ".") {
			this.pos += 1;
			this.digitRun();
		}
		if (this.text[this.pos] === "e" || this.text[this.pos] === "E") this.parseExponent();
		const value = Number(this.text.slice(start, this.pos));
		if (!Number.isFinite(value)) this.fail("invalid number");
		return value;
	}

	/** Require a run of digits at the cursor and walk past it. */
	digitRun() {
		if (!/[0-9]/.test(this.text[this.pos] ?? "")) this.fail("invalid number");
		this.digits();
	}

	/** The cursor stands on the `e` of an exponent; walk its sign and digits. */
	parseExponent() {
		this.pos += 1;
		if (this.text[this.pos] === "+" || this.text[this.pos] === "-") this.pos += 1;
		this.digitRun();
	}

	parseLiteral(word, value) {
		if (!this.text.startsWith(word, this.pos)) this.fail("invalid literal");
		this.pos += word.length;
		return value;
	}

	parseValue() {
		this.skipIgnored();
		const ch = this.text[this.pos];
		if (ch === "{") return this.parseObject();
		if (ch === "[") return this.parseArray();
		if (ch === '"') return this.parseString();
		if (ch === "-" || (ch >= "0" && ch <= "9")) return this.parseNumber();
		if (ch === "t") return this.parseLiteral("true", true);
		if (ch === "f") return this.parseLiteral("false", false);
		if (ch === "n") return this.parseLiteral("null", null);
		if (ch === undefined) this.fail("unexpected end of text");
		this.fail(`unexpected character ${JSON.stringify(ch)}`);
	}

	parseObject() {
		this.pos += 1;
		const obj = {};
		for (;;) {
			this.skipIgnored();
			const ch = this.text[this.pos];
			if (ch === "}") {
				this.pos += 1;
				return obj;
			}
			if (ch !== '"') this.fail("expected a quoted property name");
			const key = this.parseString();
			this.skipIgnored();
			if (this.text[this.pos] !== ":") this.fail("expected ':' after a property name");
			this.pos += 1;
			obj[key] = this.parseValue();
			if (this.ending(",", "}")) return obj;
		}
	}

	/**
	 * Close a container: skip the separators, then take the end token or fail.
	 * A comma followed by the end token is the trailing comma the real parse
	 * tolerates. Returns true when the container closed.
	 */
	ending(comma, close) {
		this.skipIgnored();
		const ch = this.text[this.pos];
		if (ch === comma) {
			this.pos += 1;
			return false;
		}
		if (ch === close) {
			this.pos += 1;
			return true;
		}
		this.fail(`expected '${comma}' or '${close}'`);
	}

	parseArray() {
		this.pos += 1;
		const arr = [];
		for (;;) {
			this.skipIgnored();
			const ch = this.text[this.pos];
			if (ch === "]") {
				this.pos += 1;
				return arr;
			}
			arr.push(this.parseValue());
			if (this.ending(",", "]")) return arr;
		}
	}

	/** Parse the whole text as one value with no trailing matter. */
	parse() {
		const value = this.parseValue();
		this.skipIgnored();
		if (this.pos !== this.text.length) this.fail("unexpected trailing text");
		return value;
	}
}

/** An object the preprocessor can rewrite: not an array, not null. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one function Stryker's ts-config preprocessor reads (issue #377).
 * `config` is the parsed object, `undefined` when the text is not one the
 * preprocessor can rewrite; `error` names the first fault, or is `undefined`.
 */
function parseConfigFileTextToJson(fileName, jsonText) {
	try {
		const config = new JsoncParser(jsonText).parse();
		return { config: isRecord(config) ? config : undefined, error: undefined };
	} catch (cause) {
		const messageText = cause instanceof Error ? cause.message : String(cause);
		return { config: undefined, error: { file: fileName, messageText } };
	}
}

module.exports = {
	version: "1.0.0",
	versionMajorMinor: "1.0",
	parseConfigFileTextToJson,
};
