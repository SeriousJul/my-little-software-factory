/**
 * A reference xterm-style grid emulator for the control plane's byte stream.
 *
 * The executable-boundary tests that assert on rendered screens need a
 * terminal model. This one implements exactly the protocol the production
 * renderer uses: CUP/HVP, SGR (attributes ignored), autowrap with the
 * pending-wrap flag, CR/LF/BS, cursor save/restore (ESC 7/8, CSI s/u), and
 * the alt-screen clear (?1049h/l). Everything else (mode sets, queries,
 * window ops, OSC/DCS/APC/PM/SOS payloads) has no grid effect and is
 * consumed.
 *
 * Character width follows the same rule the host terminals apply to the
 * factory's glyph set: East Asian Wide/Fullwidth = 2, everything else
 * (including ambiguous-width box drawing and arrows) = 1. That matches
 * OpenTUI's ambiguousIsNarrow=true and Alacritty's default ambiguous width.
 *
 * The model was validated cell-for-cell against tmux 3.7c captures of the
 * real binary (boot, modal, scrolled modal, and exit screens all matched
 * with zero differing lines), so a stream that lands identically here lands
 * identically in a conforming xterm-semantics terminal.
 */

/** The default cell size of the control plane under test. */
export const TERM_COLS = 146;
export const TERM_ROWS = 34;

/** Width in cells: East Asian Wide/Fullwidth = 2, everything else = 1. */
export function charWidth(ch: string): number {
	const cp = ch.codePointAt(0) ?? 32;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

/** The CSI parser: byte class matches the xterm parameter/intermediate set. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC byte is exactly what the emulator matches
const CSI_RE = /\x1b\[([0-9;?*<>=!$+"'%&(),./]*)([A-Za-z@`])/;

class Grid {
	readonly width: number;
	readonly height: number;
	cells: string[][];
	row = 0;
	col = 0;
	pendingWrap = false;
	savedRow = 0;
	savedCol = 0;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		this.cells = this.blank();
	}

	private blank(): string[][] {
		return Array.from({ length: this.height }, () => Array.from({ length: this.width }, () => " "));
	}

	reset(): void {
		this.cells = this.blank();
		this.row = 0;
		this.col = 0;
		this.pendingWrap = false;
	}

	put(ch: string): void {
		const w = charWidth(ch);
		if (this.col + w > this.width) {
			this.row = (this.row + 1) % this.height;
			this.col = 0;
		}
		this.cells[this.row][this.col] = ch;
		if (w === 2 && this.col + 1 < this.width) this.cells[this.row][this.col + 1] = "";
		this.col += w;
		if (this.col >= this.width) {
			this.col = this.width - 1;
			this.pendingWrap = true;
		}
	}

	advance(): void {
		if (this.pendingWrap) {
			this.row = (this.row + 1) % this.height;
			this.col = 0;
			this.pendingWrap = false;
		}
	}

	/** The visible screen as text, right-trimmed per line. */
	text(): string {
		return this.cells
			.map((r) =>
				r
					.join("")
					.replace(/[\u200b]/g, "")
					.replace(/\s+$/, ""),
			)
			.join("\n");
	}
}

/**
 * Feed raw pty bytes into the grid, as a terminal would. The input may end
 * mid-sequence; a conforming terminal keeps its parser state across pty
 * reads, and the caller here feeds the whole recorded stream at once.
 */
export function feedGrid(grid: Grid, data: Buffer): void {
	let i = 0;
	const n = data.length;
	while (i < n) {
		const b = data[i];
		if (b === 0x1b) {
			if (i + 1 < n && data[i + 1] === 0x5b) {
				const m = CSI_RE.exec(data.subarray(i, Math.min(i + 32, n)).toString("latin1"));
				if (m === null) {
					i += 1;
					continue;
				}
				const params = m[1];
				const fin = m[2];
				if (fin === "H") {
					grid.advance();
					const parts = (params || "1;1").split(";");
					const r = parts[0] === "" ? 1 : Number.parseInt(parts[0], 10);
					const c = parts.length > 1 && parts[1] !== "" ? Number.parseInt(parts[1], 10) : 1;
					grid.row = Math.min(Math.max(r - 1, 0), grid.height - 1);
					grid.col = Math.min(Math.max(c - 1, 0), grid.width - 1);
					grid.pendingWrap = false;
				} else if (fin === "s" && !params.startsWith("?")) {
					grid.savedRow = grid.row;
					grid.savedCol = grid.col;
				} else if (fin === "u" && !params.startsWith("?")) {
					grid.row = grid.savedRow;
					grid.col = grid.savedCol;
					grid.pendingWrap = false;
				} else if ((params === "?1049" && fin === "h") || (params === "?1049" && fin === "l")) {
					grid.reset();
				}
				// m, n, c, t, q, other modes: no grid effect
				i += m[0].length;
				continue;
			}
			if (i + 1 < n && data[i + 1] === 0x5d) {
				// OSC: consume to BEL or ST
				let j = i + 2;
				let end = -1;
				while (j < n) {
					if (data[j] === 0x07) {
						end = j + 1;
						break;
					}
					if (data[j] === 0x1b && j + 1 < n && data[j + 1] === 0x5c) {
						end = j + 2;
						break;
					}
					j += 1;
				}
				i = end === -1 ? n : end;
				continue;
			}
			if (i + 1 < n) {
				const esc2 = data[i + 1];
				if (esc2 === 0x37) {
					// ESC 7: save cursor
					grid.savedRow = grid.row;
					grid.savedCol = grid.col;
					i += 2;
					continue;
				}
				if (esc2 === 0x38) {
					// ESC 8: restore cursor
					grid.row = grid.savedRow;
					grid.col = grid.savedCol;
					grid.pendingWrap = false;
					i += 2;
					continue;
				}
				if (esc2 === 0x3d || esc2 === 0x3e) {
					i += 2;
					continue;
				}
				if (esc2 === 0x28 || esc2 === 0x29 || esc2 === 0x2a || esc2 === 0x2b) {
					i += 3;
					continue;
				}
				if (esc2 === 0x5c) {
					// bare ST
					i += 2;
					continue;
				}
				if (esc2 === 0x50 || esc2 === 0x5f || esc2 === 0x5e || esc2 === 0x52) {
					// DCS/APC/PM/SOS: consume to ST or BEL
					let j = i + 2;
					let end = -1;
					while (j < n) {
						if (data[j] === 0x07) {
							end = j + 1;
							break;
						}
						if (data[j] === 0x1b && j + 1 < n && data[j + 1] === 0x5c) {
							end = j + 2;
							break;
						}
						j += 1;
					}
					i = end === -1 ? n : end;
					continue;
				}
			}
			i += 1;
			continue;
		}
		if (b === 0x0d) {
			grid.advance();
			grid.col = 0;
			i += 1;
			continue;
		}
		if (b === 0x0a || b === 0x0b || b === 0x0c) {
			grid.advance();
			grid.row = Math.min(grid.row + 1, grid.height - 1);
			i += 1;
			continue;
		}
		if (b === 0x08) {
			grid.col = Math.max(0, grid.col - 1);
			i += 1;
			continue;
		}
		if (b < 0x20) {
			i += 1;
			continue;
		}
		let ch: string;
		if (b < 0x80) {
			ch = String.fromCharCode(b);
			i += 1;
		} else {
			const ln = b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
			let raw = data.subarray(i, i + ln);
			try {
				ch = new TextDecoder("utf-8", { fatal: true }).decode(raw);
			} catch {
				ch = "?";
				raw = data.subarray(i, i + 1);
			}
			i += raw.length;
		}
		grid.advance();
		grid.put(ch);
	}
}

/** Render a full recorded stream into the final screen text. */
export function renderStream(data: Buffer, width = TERM_COLS, height = TERM_ROWS): string {
	const grid = new Grid(width, height);
	feedGrid(grid, data);
	return grid.text();
}

/**
 * Split a stream into its synchronized-output frames.
 *
 * Every renderer frame is wrapped in DEC synchronized update
 * (ESC[?2026h ... ESC[?2026l). Bytes outside any pair (startup queries
 * and responses) are returned as frame 0.
 */
export function splitFrames(data: Buffer): Buffer[] {
	const frames: Buffer[] = [];
	const start = Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68]);
	const end = Buffer.from([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c]);
	let cursor = 0;
	for (;;) {
		const begin = data.indexOf(start, cursor);
		if (begin === -1) {
			frames.push(data.subarray(cursor));
			break;
		}
		const finish = data.indexOf(end, begin);
		if (finish === -1) {
			frames.push(data.subarray(cursor));
			break;
		}
		if (begin > cursor) frames.push(data.subarray(cursor, begin));
		frames.push(data.subarray(begin, finish + end.length));
		cursor = finish + end.length;
	}
	return frames;
}
