/**
 * The tables each aggregate owns (issue #202, ADR 0092).
 *
 * One map, read three ways: the store hands each aggregate a statement handle
 * scoped to its own entries, so a statement that names another aggregate's
 * table fails when it is prepared; the boundary check reads the same map to
 * prove every table the schema creates has exactly one owner; and a new table
 * with no entry here is a table no aggregate claims, which the check refuses.
 */

/** The nine aggregates, keyed as the composition keys them. */
export const TABLES_OWNED = {
	consultationRecord: [
		"consultations",
		"consultation_turns",
		"consultation_snapshots",
		"consultation_resources",
		"consultation_remaining_resources",
		"consultation_pending_responses",
		"checkout_conflict_confirmations",
	],
	grouping: ["grouping_axis", "group_order"],
	handoff: ["handoffs", "handoff_attempts", "auto_handoff_mode"],
	lease: ["lease"],
	planeAction: ["plane_action_attempts"],
	repositoryInit: ["repository_init"],
	sourceFact: ["source_health", "memberships"],
	ticketWorkCycle: ["tickets", "completion_traces"],
	workQueue: ["work_queue", "queue_pause"],
} as const satisfies Record<string, readonly string[]>;

export type AggregateKey = keyof typeof TABLES_OWNED;

/** The tables the seam itself owns: the version stamp the migration chain writes. */
export const SEAM_TABLES = ["schema_version"] as const;

/**
 * Tables a migration created and a later migration removed. They stand in the
 * chain's text, so the check names them instead of claiming them for an
 * aggregate that cannot read them.
 */
export const RETIRED_TABLES = ["referenced_issues"] as const;
