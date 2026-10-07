/**
 * The run's Message history at its append rule (ADR 0119): a write that
 * repeats the previous entry's severity and text adds no entry, and past the
 * 500-entry bound the oldest entry drops, so the view's scroll clamp
 * follows.
 */
import { describe, expect, test } from "bun:test";

import {
	appendHistoryEntry,
	MESSAGE_HISTORY_LIMIT,
	type MessageHistoryEntry,
} from "../src/components/message-facts.ts";

const at = 1761638400000;

describe("the history's append rule", () => {
	test("adds an entry, and a repeat of the previous entry's severity and text adds none", () => {
		const first = appendHistoryEntry([], "warning", "no Ticket sources exist", at);
		expect(first).toHaveLength(1);
		// The same severity and text again: the record keeps one entry, and the
		// repeat adds nothing even at a later moment.
		expect(appendHistoryEntry(first, "warning", "no Ticket sources exist", at + 1)).toBe(first);
		// The chip is part of the entry: a different severity, or a different
		// text, adds.
		expect(appendHistoryEntry(first, "error", "no Ticket sources exist", at + 1)).toHaveLength(2);
		expect(appendHistoryEntry(first, "warning", "a different fact", at + 1)).toHaveLength(2);
	});

	test("holds the bound at 500 entries, dropping the oldest", () => {
		let history: MessageHistoryEntry[] = [];
		const total = MESSAGE_HISTORY_LIMIT + 25;
		for (let n = 0; n < total; n++) {
			history = appendHistoryEntry(history, "info", `the fact ${n}`, at + n);
		}
		expect(history).toHaveLength(MESSAGE_HISTORY_LIMIT);
		expect(history[0]?.text).toBe(`the fact ${total - MESSAGE_HISTORY_LIMIT}`);
		expect(history.at(-1)?.text).toBe(`the fact ${total - 1}`);
		// A repeat of the newest entry adds nothing at the bound either.
		expect(appendHistoryEntry(history, "info", `the fact ${total - 1}`, at + total)).toBe(history);
	});

	test("the entries keep the order the plane stated them, oldest first", () => {
		let history = appendHistoryEntry([], "warning", "the fact 0", at);
		history = appendHistoryEntry(history, "info", "the fact 1", at + 1);
		history = appendHistoryEntry(history, "error", "the fact 2", at + 2);
		expect(history.map((entry) => entry.text)).toEqual(["the fact 0", "the fact 1", "the fact 2"]);
	});
});
