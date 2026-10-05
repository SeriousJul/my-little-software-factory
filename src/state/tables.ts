/**
 * The tables each aggregate owns (issue #202, ADR 0095).
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
	handoff: ["handoffs", "handoff_attempts", "auto_handoff_mode", "name_collisions"],
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
 * read the same way as one written `FROM tickets`. A name may carry its schema
 * (`FROM main.tickets`), and the reach is the table, not the schema that holds
 * it, so the refusal names `tickets` (issue #202 review). A name may be quoted
 * (`FROM "handoffs"`, `FROM [handoffs]`, `` FROM `handoffs` ``); the quotes are
 * the name's spelling, not a shield, so the reach is the name inside them and
 * the refusal names `handoffs` (issue #202 review). An `UPDATE` is read
 * only in its `UPDATE <table> SET` shape, and the `SET` is read as a whole
 * word, so an upsert's `DO UPDATE SET` names no table and a column named
 * `settings_hash` is never taken for one. The shape-changing statements are
 * read too: `ALTER TABLE`, `DROP TABLE`, `CREATE TABLE`, `CREATE INDEX ... ON
 * <table>`, `ALTER TABLE ... RENAME TO`, and `REFERENCES` each name a table the
 * statement builds, destroys, or points at (issue #202 review). A handle that
 * can read a table can drop it, so the matcher reports the reach the same way
 * for both. The migration chain in `schema.ts` runs its DDL on the store's own
 * handle, never on an aggregate's scope, so these keywords refuse no aggregate
 * statement today; they stand so the runtime line and the review line stay one
 * line. This is the one matcher: the store's scoped handle refuses with it, and
 * the boundary check reads the source with it, so the two rules cannot drift
 * apart.
 */
const BARE_NAME = "[A-Za-z_][A-Za-z0-9_]*";
/**
 * A quoted SQLite identifier: `"name"`, `[name]`, or `` `name` ``. A doubled
 * quote inside the quotes is the name's own character, so `"a""b"` is the name
 * `a"b`.
 */
const QUOTED_NAME = '"(?:[^"]|"")+"|\\[(?:[^\\]]|\\]\\])+\\]|`(?:[^`]|``)+`';
const TABLE_NAME = `(?:${BARE_NAME}|${QUOTED_NAME})`;
const TABLE_REFERENCE = new RegExp(
	`\\b(?:FROM|JOIN|INTO)\\s+(?:${TABLE_NAME}\\.)?(${TABLE_NAME})` +
		`|\\bUPDATE\\s+(?:OR\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\\s+)?(?:${TABLE_NAME}\\.)?(${TABLE_NAME})\\s+SET\\b`,
	"giu",
);

/**
 * The names a statement defines for itself: a CTE's name (`WITH held AS (`),
 * and a subquery's alias (`FROM (SELECT ...) AS held`, `FROM (SELECT ...) held`).
 * These are not tables the aggregate reaches; they are names the statement
 * binds, so the scope rule lets them through - but only while no aggregate
 * claims the name (issue #202 review). A statement that calls its own
 * subquery `handoffs` hides what the subquery reads, and the hiding is the
 * reach: `select attempt_id from (select attempt_id from handoffs) as handoffs`
 * reaches `handoffs` whatever it calls the result. A name no aggregate claims
 * (`held`, `rows`, a column list) is still just a name the statement bound.
 */
const STATEMENT_ALIAS = new RegExp(
	`(?:^|(?<=\\W))(${TABLE_NAME})\\s+AS\\s*\\(|\\)\\s*(?:AS\\s+)?(${TABLE_NAME})`,
	"giu",
);

/**
 * The statements that change the file's shape rather than its rows. A handle
 * scoped to a table can read that table, and a handle that can read a table can
 * drop it, so a `DROP TABLE handoffs` run through the Grouping handle is the
 * same reach as a `SELECT ... FROM handoffs` and is reported the same way
 * (issue #202 review). `CREATE INDEX` names its own index and the table the
 * index stands on; only the table is a reach. `REFERENCES` names the table a
 * foreign key points at.
 */
const DDL_REFERENCE = new RegExp(
	`\\b(?:ALTER|DROP)\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:${TABLE_NAME}\\.)?(${TABLE_NAME})` +
		`|\\bCREATE\\s+(?:TEMP\\s+|TEMPORARY\\s+|VIRTUAL\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?` +
		`(?:${TABLE_NAME}\\.)?(${TABLE_NAME})` +
		`|\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${TABLE_NAME}\\s+ON\\s+` +
		`(?:${TABLE_NAME}\\.)?(${TABLE_NAME})` +
		`|\\bRENAME\\s+TO\\s+(?:${TABLE_NAME}\\.)?(${TABLE_NAME})` +
		`|\\bREFERENCES\\s+(?:${TABLE_NAME}\\.)?(${TABLE_NAME})`,
	"giu",
);

/**
 * The name a spelling stands for, in lower case. `"handoffs"`, `[handoffs]`,
 * `` `handoffs` ``, `HANDOFFS`, and `main.handoffs` all answer `handoffs`, so
 * the quoted form reaches the same table as the bare one and a quoted alias is
 * matched against the claimed names the same way.
 */
function nameSpelled(raw: string): string {
	const name = raw.toLowerCase();
	if (name.startsWith('"')) return name.slice(1, -1).replace(/""/gu, '"');
	if (name.startsWith("[")) return name.slice(1, -1).replace(/\]\]/gu, "]");
	if (name.startsWith("`")) return name.slice(1, -1).replace(/``/gu, "`");
	return name;
}

/**
 * Every table name the module claims: the nine aggregates' tables and the
 * seam's own version stamp. A statement-bound name that stands in this set is
 * not a fresh name; it is a table name, and the reach behind it is reported.
 */
const CLAIMED_TABLE_NAMES = new Set<string>([
	...Object.values(TABLES_OWNED).flat(),
	...SEAM_TABLES,
]);

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
 * The table a match names: the first group that holds a name. Each pattern
 * holds one capture group per shape it reads - the table of a `FROM`, the table
 * of an `UPDATE`, the table an index stands on - and the shapes are mutually
 * exclusive, so exactly one group is set.
 */
function tableMatched(match: RegExpMatchArray): string {
	for (const group of match.slice(1)) {
		if (group === undefined) continue;
		const name = nameSpelled(group);
		if (name !== "") return name;
	}
	return "";
}

/**
 * The table names a statement reaches, in the order it names them and in lower
 * case, so the comparison is the same whatever case the SQL is written in. A
 * quoted value names nothing, a schema prefix names the table under it and not
 * the schema, and a name the statement defines for itself - a CTE or a subquery
 * alias - is not a reach, so neither is reported. A name the statement defines
 * for itself is a reach when some aggregate claims that name, because then the
 * statement is standing a claimed table in for its own result.
 */
export function tablesNamed(sql: string): string[] {
	const statement = withoutQuotedValues(sql);
	const aliases = new Set<string>();
	for (const match of statement.matchAll(STATEMENT_ALIAS)) {
		const alias = tableMatched(match);
		if (alias === "" || CLAIMED_TABLE_NAMES.has(alias)) continue;
		aliases.add(alias);
	}
	const reached: Array<{ at: number; table: string }> = [];
	for (const pattern of [TABLE_REFERENCE, DDL_REFERENCE]) {
		for (const match of statement.matchAll(pattern)) {
			const table = tableMatched(match);
			if (table === "" || aliases.has(table)) continue;
			reached.push({ at: match.index, table });
		}
	}
	return reached.sort((a, b) => a.at - b.at).map((reach) => reach.table);
}
