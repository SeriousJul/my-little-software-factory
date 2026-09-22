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
 * rank of the issues it closes and the tickets it fixes (ADR 0023, ADR
 * 0042): after its own override and own label, the inheritance step reads
 * each rank source by that source's own chain.
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
	 * either way, and the detail's Priority fact line states this same
	 * label, so the line shows the stored fact.
	 */
	label: string | null;
	/** Where the effective rank comes from. */
	source: PrioritySource;
	/**
	 * The source of the inherited rank: the source kind and external key of
	 * the ticket that supplied it - the issue the pull request closes, or
	 * the fixing ticket the branch link names (ADR 0023, ADR 0042). Null
	 * when the rank is not inherited.
	 */
	inheritedFrom: { sourceKind: string; externalKey: string } | null;
}

/**
 * The effective rank of one ticket.
 *
 * In order: (1) the Priority override - a label from the list, or off, which
 * forces the ticket unranked, (2) the best rank among the ticket's own
 * labels in the list, (3) unranked. An override value that is no longer in
 * the list names no rank, so it ranks nothing: the list owns the scale. The
 * stored label stays stated for off and for a dropped label alike, so the
 * detail's Priority fact line shows the stored fact.
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

/** The facts of one rank source as the inheritance step reads them (ADR 0023, ADR 0042). */
export interface RankSource {
	/**
	 * The source's number in its repository: the tie-break the inheritance
	 * step uses. A source that names no number (the security advisory) takes
	 * the caller's sentinel, so it loses every tie.
	 */
	number: number;
	/** The source's labels, from its snapshot or its Referenced issue fact. */
	labels: readonly string[];
	/** The source's Priority override when it is a ticket, else null. */
	override: string | null;
	/**
	 * The source kind of the ticket that stands behind the source; what the
	 * detail pane names beside the inherited rank.
	 */
	sourceKind: string;
	/** The external key of that ticket, beside its source kind. */
	externalKey: string;
}

/**
 * The inheritance step of the effective rank (ADR 0023, ADR 0042).
 *
 * The best effective rank among a pull request's rank sources - its Issue
 * references and the tickets it fixes - each resolved by the source's own
 * chain: its Priority override when it is a ticket, then its labels, then
 * unranked. When two sources tie at the best rank, the lowest number
 * supplies it, so the detail pane names one source. When no source is
 * ranked, the step ranks nothing.
 */
export function inheritedPriority(
	labels: readonly string[],
	references: readonly RankSource[],
): TicketPriority {
	let best: {
		rank: number;
		label: string;
		number: number;
		sourceKind: string;
		externalKey: string;
	} | null = null;
	for (const reference of references) {
		const priority = effectivePriority(labels, reference.override, reference.labels);
		if (priority.rank === null) continue;
		if (
			best === null ||
			priority.rank < best.rank ||
			(priority.rank === best.rank && reference.number < best.number)
		)
			best = {
				rank: priority.rank,
				label: priority.label ?? "",
				number: reference.number,
				sourceKind: reference.sourceKind,
				externalKey: reference.externalKey,
			};
	}
	if (best === null) return { rank: null, label: null, source: "none", inheritedFrom: null };
	return {
		rank: best.rank,
		label: best.label,
		source: "inherited",
		inheritedFrom: { sourceKind: best.sourceKind, externalKey: best.externalKey },
	};
}

/**
 * The effective rank of a pull request (ADR 0023, ADR 0042).
 *
 * The pull request's own chain - its Priority override, then its own label -
 * beats the inheritance step. Only an unranked pull request inherits: the
 * best effective rank among its rank sources - the issues it closes and the
 * tickets it fixes - takes the third slot of the chain, so the pull
 * request's own facts never lose to them. An issue ticket, which carries no
 * rank sources, reads exactly its own chain.
 */
export function effectivePullRequestPriority(
	labels: readonly string[],
	override: string | null,
	ownLabels: readonly string[],
	references: readonly RankSource[],
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
 * The singular word the detail pane states for the kind of an inherited
 * rank's source (ADR 0042): issue and advisory each name their own word, and
 * both alert kinds name the shared `alert`. A kind without a word states no
 * word, and the pane shows the label alone.
 */
function inheritedSourceWord(sourceKind: string): string | null {
	switch (sourceKind) {
		case "github-issue":
			return "issue";
		case "github-security-advisory":
			return "advisory";
		case "github-dependabot-alert":
		case "github-secret-scanning-alert":
			return "alert";
		default:
			return null;
	}
}

/**
 * The word the detail pane and the gallery use for the source of a rank.
 * The override is the operator's own setting, the label is the ticket's, and
 * the inherited rank names its source by kind and key - `issue #5`,
 * `alert #9`, `advisory GHSA-...` (ADR 0023, ADR 0042).
 */
export function prioritySourceWord(priority: TicketPriority): string | null {
	if (priority.source === "override") return "set by you";
	if (priority.source === "label") return "its own label";
	if (priority.source === "inherited" && priority.inheritedFrom !== null) {
		const word = inheritedSourceWord(priority.inheritedFrom.sourceKind);
		return word === null ? null : `${word} ${priority.inheritedFrom.externalKey}`;
	}
	return null;
}
