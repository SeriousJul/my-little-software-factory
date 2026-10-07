/**
 * The Message line's facts: what kind of message is visible, and why, beside
 * the run's history of the facts the line has been asked to state.
 *
 * Severity and Fault are two axes (ADR 0118): the severity is the word and the
 * color on the line, and the Fault is a warning or an error the plane met on
 * its own rather than an answer to a key the operator pressed. The writers
 * own both channels at their interface: `warning`, `error`, `news`, and
 * `notice` write the line only, and `faultWarning` and `faultError` write the
 * line and send the desktop notification. Every write site takes one of the
 * two, so the channel is visible where the fact is written.
 *
 * The history is the Message line's own record (ADR 0119): per run, in memory,
 * bounded at 500 entries. It holds the four kinds that stand - an operation's
 * outcome, a control's news, a notice, and source health - and no `Working`
 * progress line.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AttentionService } from "../attention.ts";
import { type MessageFact, type MessageFacts, selectMessage } from "./messages.ts";

/**
 * Which operation owns a progress line.
 *
 * The owner is the operation's own identity, never its kind. Only one refresh
 * and one Handoff runs at a time, so their names are enough for them. A
 * transition re-fire (ADR 0054) also runs single-flight, behind its own
 * guard, so its name stands alone. Any number of Consultation operations run
 * at once - one per Repository - so each carries the Consultation it works
 * on. Each owner clears the progress it wrote when it settles: a Handoff's
 * completion must not erase a refresh the operator started while it ran, a
 * settled refresh must not erase the Handoff it covers, and the settle of one
 * Consultation operation must not erase the progress of the one still running
 * beside it.
 */
export type WorkingOwner =
	| "refresh"
	| "handoff"
	| "refire"
	| "repository-init"
	| `consultation:${string}`;

/** The progress owner of one Consultation operation. */
export const consultationProgressOwner = (consultationId: string): WorkingOwner =>
	`consultation:${consultationId}`;

/**
 * Whose progress line a call may clear.
 *
 * `none` names a caller that writes no progress line of its own: an action
 * that ends the outcome it left on the Message line and leaves whatever
 * progress is running alone.
 */
export type ProgressOwner = WorkingOwner | "none";

/** The severities one history entry wears: the chips the Message view holds. */
export type MessageHistorySeverity = "info" | "warning" | "error";

/** One fact the Message line was asked to state during the run, in order. */
export interface MessageHistoryEntry {
	severity: MessageHistorySeverity;
	text: string;
	/** The epoch milliseconds of the write's local time. */
	at: number;
}

/** The one Ticket source a stale-source fact names, with its error if it carries one. */
export interface StaleSourceFact {
	name: string;
	error?: string;
}

/** The boot notice the app starts with: the Theme fallback warning, the plane's degraded boot. */
export interface InitialNotice {
	severity: "info" | "warning";
	text: string;
}

/**
 * The history's bound: past it the oldest entry drops, and the view's scroll
 * clamp follows (ADR 0119).
 */
export const MESSAGE_HISTORY_LIMIT = 500;

/**
 * Append one fact to the run's history, in order.
 *
 * A write that repeats the previous entry's severity and text adds no entry,
 * and past the bound the oldest entry drops, the view's scroll clamp
 * following (ADR 0119). Each entry carries the local time of its write, not
 * the moment the row showed it, so the record follows the order the plane
 * stated its facts rather than one row's paint order.
 */
export function appendHistoryEntry(
	current: MessageHistoryEntry[],
	severity: MessageHistorySeverity,
	text: string,
	at: number,
): MessageHistoryEntry[] {
	const last = current.at(-1);
	if (last !== undefined && last.severity === severity && last.text === text) return current;
	const next = [...current, { severity, text, at }];
	return next.length > MESSAGE_HISTORY_LIMIT
		? next.slice(next.length - MESSAGE_HISTORY_LIMIT)
		: next;
}

/**
 * The line one stale source's fact wears, in the order the source facts give:
 * the name, the health word, and the error the read left beside it.
 */
export function staleSourceLine(source: StaleSourceFact): string {
	return `${source.name}: stale${source.error === undefined ? "" : ` - ${source.error}`}`;
}

/**
 * The working, operation, news, notice, and source-health facts behind the
 * Message line, with the writers the shell dispatches through, and the run's
 * history of the facts the line has been asked to state. The display value
 * (prefix and truncation) stays with the shell, which knows the terminal
 * width.
 */
export function useMessageFacts(
	/** The Ticket sources that are stale right now, in the order the sources list holds. */
	staleSources: readonly StaleSourceFact[],
	/** A notice the app starts with, here the Theme fallback's. */
	initialNotice: InitialNotice | undefined,
	/**
	 * The plane's out-of-band attention (ADR 0080): only a Fault sends its
	 * fact to the desktop, one notification per standing fact. The line-only
	 * writers - warning, error, news, notice - send nothing: they are answers
	 * to a key the operator pressed, or facts with nothing in them that waits
	 * for nobody. The working and source-health facts ride the same rule:
	 * progress is not a fact, and the stale-source transition is the source
	 * health's own Fault.
	 */
	attention: AttentionService,
) {
	const [facts, setFacts] = useState<MessageFacts>(() =>
		initialNotice === undefined
			? {}
			: { notice: { severity: initialNotice.severity, text: initialNotice.text } },
	);
	// The run's history of the facts the line was asked to state, oldest first.
	// It is session view state like the Starting window and the notification's
	// standing-fact memory, not a machine fact the state file reads back: a
	// restart empties it, and the durable record stays the log file.
	const [history, setHistory] = useState<MessageHistoryEntry[]>(() =>
		initialNotice === undefined
			? []
			: [{ severity: initialNotice.severity, text: initialNotice.text, at: Date.now() }],
	);
	// The progress lines of the operations that are running right now, oldest
	// first. One Message line shows the last one written, and a settle returns
	// the line to whichever operation still runs.
	const workingLines = useRef(new Map<WorkingOwner, string>());

	/** Add one fact to the history, on the append's own rule. */
	const record = useCallback((severity: MessageHistorySeverity, text: string) => {
		setHistory((current) => appendHistoryEntry(current, severity, text, Date.now()));
	}, []);

	/** The line a settle leaves on the Message line: the next runner's, if any. */
	const visibleWorking = useCallback((): string | undefined => {
		const entries = [...workingLines.current.values()];
		return entries.at(-1);
	}, []);

	const dropWorking = useCallback((owner: WorkingOwner) => {
		if (!workingLines.current.has(owner)) return false;
		workingLines.current.delete(owner);
		return true;
	}, []);

	/**
	 * Write one operation's progress line.
	 *
	 * A new operation replaces the outcome the last one left on the line with
	 * its own Working progress, and the covered operation's own line returns
	 * when it settles. Source health is not an operation: it survives so it can
	 * return when the progress clears. No Working line enters the history:
	 * progress is transient by design, it would flood the record, and the
	 * outcome that ends it already states the result.
	 */
	const working = useCallback((text: string, owner: WorkingOwner) => {
		// Rewrite the owner's entry last, so it is the line the Message shows.
		workingLines.current.delete(owner);
		workingLines.current.set(owner, text);
		setFacts((current) => ({ ...current, working: text, operation: undefined }));
	}, []);

	/**
	 * State what a control did, when it did it and there is nothing to warn about.
	 *
	 * A result is not a refusal and not progress, so it holds its own slot and
	 * wears its own prefix: the line an operator reads after a control that ran
	 * must not say `Warning:` about a copy that took. It records an info entry,
	 * because the result the line states is the fact the history holds.
	 */
	const news = useCallback(
		(text: string) => {
			setFacts((current) => ({
				...current,
				operation: undefined,
				notice: undefined,
				news: text,
			}));
			record("info", text);
		},
		[record],
	);

	/**
	 * Answer a control the app will decide without the operator.
	 *
	 * A notice is not progress: it holds its own slot, below the facts an
	 * operation writes, and the next fact of any kind, or the end of the
	 * progress line it waits behind, takes the line back. It can never pin
	 * the Message line. It never outranks a fact an operation wrote, so it
	 * keeps the operation fact it lands beside: the outcome warning the start
	 * it answers leaves on the line stands over the notice, and the next
	 * operation's own fact takes the line from both. The severity it wears is
	 * the one it was written with: a refusal's warning by default, and the
	 * info of a plain result where the site says so.
	 */
	const notice = useCallback(
		(text: string, severity: "info" | "warning" = "warning") => {
			setFacts((current) => ({ ...current, news: undefined, notice: { severity, text } }));
			record(severity, text);
		},
		[record],
	);

	// An outcome never destroys the active progress: the selector ranks the
	// facts, so a Warning written during a refresh waits behind its Working
	// line and appears when the refresh settles (user story 51). Only a new
	// operation, which writes its own Working, replaces an outcome.
	//
	// The line-only writers write the line and record the history entry, and
	// send nothing: the fact answers a key the operator pressed, or it has no
	// severity the desktop carries. The fault writers do the same write and
	// send the notification, one per standing fact (ADR 0080).
	const warning = useCallback(
		(text: string) => {
			setFacts((current) => ({
				...current,
				operation: { severity: "warning", text },
				news: undefined,
				notice: undefined,
			}));
			record("warning", text);
		},
		[record],
	);

	const error = useCallback(
		(text: string) => {
			setFacts((current) => ({
				...current,
				operation: { severity: "error", text },
				news: undefined,
				notice: undefined,
			}));
			record("error", text);
		},
		[record],
	);

	const faultWarning = useCallback(
		(text: string) => {
			warning(text);
			attention.notify({ severity: "warning", text });
		},
		[warning, attention],
	);

	const faultError = useCallback(
		(text: string) => {
			error(text);
			attention.notify({ severity: "error", text });
		},
		[error, attention],
	);

	/**
	 * End one operation: its outcome, and only the progress line it owns.
	 *
	 * A clean success clears its own `Working:` line and reveals any source
	 * health still under it. The progress of an operation still running is
	 * never erased: a Handoff that settles while a Consultation runs returns
	 * the line to that Consultation rather than leaving it blank (user
	 * story 16), and so does the notice that answers the operator's last
	 * control.
	 */
	const clearOperation = useCallback(
		(owner: ProgressOwner) => {
			const owned = owner === "none" ? false : dropWorking(owner);
			setFacts((current) => ({
				...current,
				operation: undefined,
				news: undefined,
				notice: undefined,
				working: owned ? visibleWorking() : current.working,
			}));
		},
		[dropWorking, visibleWorking],
	);

	/** End one operation's progress line, and only that one. */
	const clearWorking = useCallback(
		(owner: ProgressOwner) => {
			const owned = owner === "none" ? false : dropWorking(owner);
			if (!owned) return;
			setFacts((current) => ({
				...current,
				working: visibleWorking(),
				notice: undefined,
			}));
		},
		[dropWorking, visibleWorking],
	);

	/** End progress while preserving the outcome it uncovered. */
	const clearProgress = useCallback(
		(owner: ProgressOwner) => {
			const owned = owner === "none" ? false : dropWorking(owner);
			if (!owned) return;
			setFacts((current) => ({ ...current, working: visibleWorking() }));
		},
		[dropWorking, visibleWorking],
	);

	// The line the Message shows for the sources that are stale right now: the
	// same join the line always stated, one fact per source, in the order the
	// sources list holds. The selector ranks it below every fact an operation
	// wrote, the way it always did.
	const sourceHealth = useMemo(
		() => (staleSources.length === 0 ? undefined : staleSources.map(staleSourceLine).join("; ")),
		[staleSources],
	);

	// Source health is a Fault at the change (ADR 0118 and ADR 0119): a source
	// that goes stale lands one history entry and one notification, sends none
	// again while it stays stale, and a source that recovers lands one info
	// entry, so the record reads the whole condition.
	const prevStale = useRef(new Map<string, string>());
	useEffect(() => {
		const current = new Map(staleSources.map((source) => [source.name, staleSourceLine(source)]));
		const previous = prevStale.current;
		for (const [name, line] of current) {
			if (!previous.has(name)) {
				record("warning", line);
				attention.notify({ severity: "warning", text: line });
			}
		}
		for (const name of previous.keys()) {
			if (!current.has(name)) record("info", `${name}: recovered`);
		}
		prevStale.current = current;
	}, [staleSources, attention, record]);

	const message = useMemo(() => selectMessage({ ...facts, sourceHealth }), [facts, sourceHealth]);

	/**
	 * Report the result of a control that ran, routed by the severity the
	 * control named.
	 *
	 * A copy that took is news; a copy the terminal refused is a warning the
	 * operator must keep. The control states which in the fact it reports, and
	 * the shell writes the matching slot, so a surface never has to choose the
	 * channel its result belongs on. A control's result answers the key the
	 * operator just pressed, so every routing is line-only: none of them is a
	 * Fault.
	 */
	const report = useCallback(
		(fact: MessageFact) => {
			if (fact.severity === "info") news(fact.text);
			else if (fact.severity === "warning") warning(fact.text);
			else error(fact.text);
		},
		[news, warning, error],
	);

	return {
		message,
		history,
		working,
		news,
		notice,
		warning,
		error,
		faultWarning,
		faultError,
		report,
		clearOperation,
		clearWorking,
		clearProgress,
	};
}
