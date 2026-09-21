/**
 * The ticket priority (ADR 0022): the rank that orders tickets.
 *
 * A ticket's rank is its Priority override, or the best rank among the
 * ticket's own labels in the Priority label list, or none. The list is an
 * ordered list of labels in the config file, first entry highest. A label
 * that is not in the list gives no rank, a duplicate takes the rank of its
 * first occurrence, and a missing or empty list ranks no ticket.
 *
 * A pull request that ranks nothing on its own inherits the best effective
 * rank of the issues it closes (ADR 0023): after its own override and own
 * label, the inheritance step reads each referenced issue by that issue's
 * own chain.
 *
 * This module owns the rank function and the one comparator that orders
 * tickets wherever priority matters. The state stores the override, and the
 * screens show the rank: nothing else re-derives an order of its own.
 */

/** The Priority override value that forces a ticket unranked. */
export const PRIORITY_OFF = "off";

/** Where a ticket's effective rank comes from. */
export type PrioritySource = "override" | "label" | "inherited" | "none";

/** The effective priority of one ticket against one Priority label list. */
export interface TicketPriority {
	/** The rank's index into the label list, or null for an unranked ticket. */
	rank: number | null;
	/**
	 * The label of the rank, or the override's stored label when it names no
	 * rank: off, or a label the config list dropped. The ticket is unranked
	 * either way, and the detail's fact line and Override row state this same
	 * label, so the two rows agree on the stored fact.
	 */
	label: string | null;
	/** Where the effective rank comes from. */
	source: PrioritySource;
	/**
	 * The issue number that supplied the rank, when it is inherited through
	 * the pull request's Issue references (ADR 0023). Null otherwise.
	 */
	inheritedFrom: number | null;
}

/**
 * The effective rank of one ticket.
 *
 * In order: (1) the Priority override - a label from the list, or off, which
 * forces the ticket unranked, (2) the best rank among the ticket's own
 * labels in the list, (3) unranked. An override value that is no longer in
 * the list names no rank, so it ranks nothing: the list owns the scale. The
 * stored label stays stated for off and for a dropped label alike, so the
 * detail's fact line and Override row show the same stored fact.
 */
export function effectivePriority(
	labels: readonly string[],
	override: string | null,
	ownLabels: readonly string[],
): TicketPriority {
	if (override !== null) {
		const at = labels.indexOf(override);
		if (at !== -1) return { rank: at, label: override, source: "override", inheritedFrom: null };
		return { rank: null, label: override, source: "override", inheritedFrom: null };
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
	if (best !== null) return { rank: best, label: bestLabel, source: "label", inheritedFrom: null };
	return { rank: null, label: null, source: "none", inheritedFrom: null };
}

/** The facts of one Issue reference as the inheritance step reads them (ADR 0023). */
export interface ReferencedIssueRank {
	/** The issue's number in its repository; what the detail pane names. */
	number: number;
	/** The issue's labels, from its snapshot or its Referenced issue fact. */
	labels: readonly string[];
	/** The issue's Priority override when it is a ticket, else null. */
	override: string | null;
}

/**
 * The inheritance step of the effective rank (ADR 0023).
 *
 * The best effective rank among a pull request's Issue references, each
 * resolved by the issue's own chain: its Priority override when it is a
 * ticket, then its labels, then unranked. When two references tie at the
 * best rank, the lowest issue number supplies it, so the detail pane names
 * one issue. When no reference is ranked, the step ranks nothing.
 */
export function inheritedPriority(
	labels: readonly string[],
	references: readonly ReferencedIssueRank[],
): TicketPriority {
	let best: { rank: number; label: string; number: number } | null = null;
	for (const reference of references) {
		const priority = effectivePriority(labels, reference.override, reference.labels);
		if (priority.rank === null) continue;
		if (
			best === null ||
			priority.rank < best.rank ||
			(priority.rank === best.rank && reference.number < best.number)
		)
			best = { rank: priority.rank, label: priority.label ?? "", number: reference.number };
	}
	if (best === null) return { rank: null, label: null, source: "none", inheritedFrom: null };
	return {
		rank: best.rank,
		label: best.label,
		source: "inherited",
		inheritedFrom: best.number,
	};
}

/**
 * The effective rank of a pull request (ADR 0023).
 *
 * The pull request's own chain - its Priority override, then its own label -
 * beats the inheritance step. Only an unranked pull request inherits: the
 * best effective rank among its Issue references takes the third slot of
 * the chain, so the pull request's own facts never lose to the issues it
 * closes. An issue ticket, which carries no references, reads exactly its
 * own chain.
 */
export function effectivePullRequestPriority(
	labels: readonly string[],
	override: string | null,
	ownLabels: readonly string[],
	references: readonly ReferencedIssueRank[],
): TicketPriority {
	const own = effectivePriority(labels, override, ownLabels);
	if (own.rank !== null) return own;
	// The pull request's own `off` keeps it unranked: it is the operator's
	// override in both directions, and it beats the inherited rank.
	if (override === PRIORITY_OFF) return own;
	const inherited = inheritedPriority(labels, references);
	// When the references rank nothing, the ticket keeps its own stored
	// fact: a dropped override label stays stated the way it did before
	// inheritance existed.
	return inherited.rank !== null ? inherited : own;
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
	if (labels.length === 0)
		return {
			kind: "noop",
			message:
				"no Priority labels are configured - add a [priority] labels list to the config file",
		};
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
	if (priority.source === "inherited")
		return priority.inheritedFrom === null ? null : `issue #${priority.inheritedFrom}`;
	return null;
}
