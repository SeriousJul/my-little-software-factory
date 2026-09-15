/**
 * The ticket priority (ADR 0022): the rank that orders tickets.
 *
 * A ticket's rank is its Priority override, or the best rank among the
 * ticket's own labels in the Priority label list, or none. The list is an
 * ordered list of labels in the config file, first entry highest. A label
 * that is not in the list gives no rank, a duplicate takes the rank of its
 * first occurrence, and a missing or empty list ranks no ticket.
 *
 * This module owns the rank function and the one comparator that orders
 * tickets wherever priority matters. The state stores the override, and the
 * screens show the rank: nothing else re-derives an order of its own.
 */

/** The Priority override value that forces a ticket unranked. */
export const PRIORITY_OFF = "off";

/** Where a ticket's effective rank comes from. */
export type PrioritySource = "override" | "label" | "none";

/** The effective priority of one ticket against one Priority label list. */
export interface TicketPriority {
	/** The rank's index into the label list, or null for an unranked ticket. */
	rank: number | null;
	/** The label of the rank, or `off` when the override forces the ticket unranked. */
	label: string | null;
	/** Where the effective rank comes from. */
	source: PrioritySource;
}

/**
 * The effective rank of one ticket.
 *
 * In order: (1) the Priority override - a label from the list, or off, which
 * forces the ticket unranked, (2) the best rank among the ticket's own
 * labels in the list, (3) unranked. An override value that is no longer in
 * the list names no rank, so it ranks nothing: the list owns the scale.
 */
export function effectivePriority(
	labels: readonly string[],
	override: string | null,
	ownLabels: readonly string[],
): TicketPriority {
	if (override === PRIORITY_OFF) return { rank: null, label: PRIORITY_OFF, source: "override" };
	if (override !== null) {
		const at = labels.indexOf(override);
		if (at !== -1) return { rank: at, label: override, source: "override" };
		return { rank: null, label: null, source: "none" };
	}
	let best: number | null = null;
	let bestLabel: string | null = null;
	for (const label of ownLabels) {
		const at = labels.indexOf(label);
		if (at !== -1 && (best === null || at < best)) {
			best = at;
			bestLabel = label;
		}
	}
	if (best !== null) return { rank: best, label: bestLabel, source: "label" };
	return { rank: null, label: null, source: "none" };
}

/**
 * The one comparator: ranked before unranked, better rank first, then the
 * newest external update first, then the ticket identity.
 *
 * The caller owns what stands ahead of it: the ticket list puts the
 * attention group first, and the waiting routes keep their own precedence
 * over the open dispatch. Tickets of one rank - the unranked included - fall
 * back to the same tie-break the list had before priority existed, so a rank
 * never hides the order the operator already read.
 */
export function compareTicketPriority(
	a: { priority: TicketPriority; externalUpdatedAt: string; identity: string },
	b: { priority: TicketPriority; externalUpdatedAt: string; identity: string },
): number {
	const ra = a.priority.rank;
	const rb = b.priority.rank;
	// A ranked ticket sits above every unranked one, whatever its rank.
	if (ra === null && rb === null) {
		return (
			b.externalUpdatedAt.localeCompare(a.externalUpdatedAt) || a.identity.localeCompare(b.identity)
		);
	}
	if (ra === null) return 1;
	if (rb === null) return -1;
	// One rank against another: the lower index on the scale is the better
	// rank, so it comes first.
	if (ra !== rb) return ra - rb;
	// One rank shared: the tie-break the list had before priority existed.
	return (
		b.externalUpdatedAt.localeCompare(a.externalUpdatedAt) || a.identity.localeCompare(b.identity)
	);
}

/** The outcome of one bump: a new override value, or a no-op with its reason. */
export type PriorityBump =
	| { kind: "moved"; value: string; message: string }
	| { kind: "noop"; message: string };

/**
 * The bump movement rule.
 *
 * Up from unranked or off takes the lowest rank; up from a rank takes the
 * next better rank; up at the highest rank is a no-op. Down from a rank
 * takes the next worse rank; down from the lowest rank takes off; down from
 * off or unranked is a no-op, so the floor is explicit. A moved bump carries
 * the value to store as the Priority override: a rank, stored as the label
 * name, or off.
 *
 * @param direction `up` for the `=` key, `down` for the `-` key.
 * @param labels The Priority label list, first entry highest.
 * @param rank The ticket's current effective rank, or null when it is unranked.
 */
export function bumpPriority(
	direction: "up" | "down",
	labels: readonly string[],
	rank: number | null,
): PriorityBump {
	if (labels.length === 0) return { kind: "noop", message: "no Priority labels are configured" };
	if (direction === "up") {
		if (rank === null)
			return {
				kind: "moved",
				value: labels[labels.length - 1],
				message: `priority set to ${labels[labels.length - 1]}`,
			};
		if (rank === 0) return { kind: "noop", message: "already at the highest priority" };
		return {
			kind: "moved",
			value: labels[rank - 1],
			message: `priority raised to ${labels[rank - 1]}`,
		};
	}
	if (rank === null) return { kind: "noop", message: "already unranked" };
	if (rank === labels.length - 1)
		return { kind: "moved", value: PRIORITY_OFF, message: `priority set to ${PRIORITY_OFF}` };
	return {
		kind: "moved",
		value: labels[rank + 1],
		message: `priority lowered to ${labels[rank + 1]}`,
	};
}

/**
 * The word the detail pane and the gallery use for the source of a rank.
 * The override is the operator's own setting, and the label is the ticket's.
 */
export function prioritySourceWord(priority: TicketPriority): string | null {
	if (priority.source === "override") return "set by you";
	if (priority.source === "label") return "its own label";
	return null;
}
