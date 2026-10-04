/**
 * Section header facts (issue #201): the counts one Section header carries,
 * answered from the screen's inputs as values, and the Auto-handoff facts its
 * mode cell carries.
 *
 * The header takes these counts as values and paints them; it holds no rule of
 * its own. Every count reads the machine's facts, never the operator's view:
 * the Ticket counts read the active view (ADR 0060), the Consultation counts
 * read every record that is not closed whatever the section's History filter
 * shows, and the queue depth reads the queue itself. Cycling a filter therefore
 * moves no count and rings no bell.
 *
 * The module owns no state file, no renderer, and no palette. It answers the
 * counts, and the header paints them through the shared paint layer (ADR 0024).
 */

import type { Consultation } from "../state/consultation-record.ts";
import type { WorkQueueItem } from "../state/work-queue.ts";
import { holdsDecision, type Ticket } from "./ticket.ts";
import { inFlight } from "./ticket-facts.ts";

/** The state the Consultation header counts as awaiting the operator's answer. */
const CONSULTATION_AWAITING_STATE = "awaiting-response";

/** The states the Consultation header counts as needing recovery. */
const CONSULTATION_RECOVERY_STATES = ["missing", "failed", "closing", "opening"] as const;

/** The state no Consultation header count covers. */
const CONSULTATION_CLOSED_STATE = "closed";

/**
 * The Auto-handoff mode a Ticket header's lamp cell names (ADR 0092).
 *
 * The lamp reads the operator's share of the work, not the machine's: an auto
 * run leaves the lamp unlit, and a manual run lights it.
 */
export type AutoHandoffMode = "auto" | "manual";

/**
 * The Auto-handoff facts one Ticket header's mode cell carries.
 *
 * The cell names the mode with a lamp and a word, the Parallel limit's seat
 * count beside it (ADR 0034), and the Dispatch pause when it holds the
 * automatic works (ADR 0016). The screen that owns the factory state fills
 * these values; the header owns how they read.
 */
export interface AutoHandoffCell {
	/** Auto-handoff mode: `auto` leaves the lamp unlit, `manual` lights it. */
	mode: AutoHandoffMode;
	/** The seats the Parallel limit counts as taken. */
	seats: number;
	/** The Parallel limit. 0 states no limit, so the cell names no fraction. */
	limit: number;
	/**
	 * The Parallel limit gate's answer (ADR 0034): the seats stand at or over
	 * the limit. The screen that owns the factory state fills it from
	 * `overParallelLimit`, so the header and its paint layer hold no gate of
	 * their own and cannot drift from the gate the dispatch reads.
	 */
	overLimit: boolean;
	/** The Dispatch pause (ADR 0016): it rides the cell in auto mode only. */
	dispatchPaused: boolean;
}

/** One Section header's counts. */
export interface SectionFacts {
	/** The Ticket header's counts. */
	ticket: {
		/** The pile the ignore flag made (ADR 0060): exactly the rows the `ignored` view shows. */
		ignored: number;
		/** The ledger of the source acts (ADR 0070): exactly the rows the `muted` view shows. */
		muted: number;
		open: number;
		inFlight: number;
		/** The Tickets resting in awaiting, whatever their turn's decision. */
		awaiting: number;
		/** Tickets resting in awaiting, held against every automatic decision. */
		held: number;
	};
	/** The Consultation header's counts. */
	consultation: {
		awaitingResponse: number;
		recovery: number;
	};
	/** The Work section header's counts. */
	work: {
		/** The queue's depth: the items it holds. */
		waiting: number;
	};
}

/** The inputs the section fact module reads once per render. */
export interface SectionFactInputs {
	/** The rows the Ticket section lists. */
	tickets: readonly Ticket[];
	/** The Consultation records the machine holds: every record that is not closed. */
	consultations: readonly Consultation[];
	/** The Work queue items. */
	queue: readonly WorkQueueItem[];
	/** The list step's own answer: exactly the rows the `ignored` view shows. */
	ignored: number;
	/** The list step's own answer: exactly the rows the `muted` view shows. */
	muted: number;
}

/**
 * The counts the headers carry.
 *
 * `ignored` and `muted` are the list step's own answers, not rules re-applied
 * here: the numbers name exactly the rows the `ignored` and `muted` views show.
 * The Ticket counts read the active view, the Consultation counts read the
 * records the machine holds, and the queue depth counts the items the queue
 * holds, whatever their kind.
 */
export function sectionFacts(inputs: SectionFactInputs): SectionFacts {
	const { tickets, consultations, queue, ignored, muted } = inputs;
	const counted = consultations.filter((record) => record.state !== CONSULTATION_CLOSED_STATE);
	return {
		ticket: {
			ignored,
			muted,
			open: tickets.filter((ticket) => ticket.state === "open").length,
			inFlight: tickets.filter(inFlight).length,
			awaiting: tickets.filter((ticket) => ticket.state === "awaiting").length,
			held: tickets.filter(holdsDecision).length,
		},
		consultation: {
			awaitingResponse: counted.filter((record) => record.state === CONSULTATION_AWAITING_STATE)
				.length,
			recovery: counted.filter((record) =>
				(CONSULTATION_RECOVERY_STATES as readonly string[]).includes(record.state),
			).length,
		},
		work: { waiting: queue.length },
	};
}

/**
 * Whether the held count rings the terminal bell (user story 16): a rise rings
 * it, a fall or a steady count does not. `previous` is null on the first read,
 * where nothing is compared.
 */
export function heldBellRang(previous: number | null, current: number): boolean {
	return previous !== null && current > previous;
}
