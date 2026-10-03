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

/**
 * The tables a statement reaches.
 *
 * The keywords match in either case, so a statement written `from tickets` is
 * read the same way as one written `FROM tickets`. An `UPDATE` is read only in
 * its `UPDATE <table> SET` shape, and the `SET` is read as a whole word, so an
 * upsert's `DO UPDATE SET` names no table and a column named `settings_hash`
 * is never taken for one. This is the one matcher: the store's scoped handle
 * refuses with it, and the boundary check reads the source with it, so the
 * runtime rule and the review rule cannot drift apart.
 */
const TABLE_REFERENCE =
	/\b(?:FROM|JOIN|INTO)\s+([A-Za-z_][A-Za-z0-9_]*)|\bUPDATE\s+(?:OR\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+SET\b/giu;

/**
 * The names a statement defines for itself: a CTE's name (`WITH held AS (`),
 * and a subquery's alias (`FROM (SELECT ...) AS held`, `FROM (SELECT ...) held`).
 * These are not tables the aggregate reaches; they are names the statement
 * binds, so the scope rule lets them through.
 */
const STATEMENT_ALIAS =
	/\b([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(|\)\s*(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*)/giu;

/**
 * The statement with every single-quoted value blanked out. A quoted value is
 * text the statement stores, not a table it reaches: `SET error = 'source
 * removed from config'` names no table called `config`. A doubled quote (`''`)
 * is the value's own quote and stays inside the blanked span.
 */
function withoutQuotedValues(sql: string): string {
	let blanked = "";
	let index = 0;
	while (index < sql.length) {
		if (sql.charAt(index) !== "'") {
			blanked += sql.charAt(index);
			index += 1;
			continue;
		}
		let end = index + 1;
		while (end < sql.length) {
			if (sql.charAt(end) !== "'") {
				end += 1;
				continue;
			}
			if (sql.charAt(end + 1) === "'") {
				end += 2;
				continue;
			}
			break;
		}
		blanked += "''";
		index = end + 1;
	}
	return blanked;
}

/**
 * The table names a statement reaches, in the order it names them and in lower
 * case, so the comparison is the same whatever case the SQL is written in. A
 * quoted value names nothing, and a name the statement defines for itself - a
 * CTE or a subquery alias - is not a reach, so neither is reported.
 */
export function tablesNamed(sql: string): string[] {
	const statement = withoutQuotedValues(sql);
	const aliases = new Set<string>();
	for (const match of statement.matchAll(STATEMENT_ALIAS)) {
		const alias = (match[1] ?? match[2] ?? "").toLowerCase();
		if (alias !== "") aliases.add(alias);
	}
	const named: string[] = [];
	for (const match of statement.matchAll(TABLE_REFERENCE)) {
		const table = (match[1] ?? match[2] ?? "").toLowerCase();
		if (table === "" || aliases.has(table)) continue;
		named.push(table);
	}
	return named;
}
