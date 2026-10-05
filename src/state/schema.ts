/**
 * The one schema chain: the tables every state file is brought to and the
 * migrations that carry an older file forward. The chain stays one chain -
 * an aggregate does not migrate its own tables.
 */

import type { Database } from "bun:sqlite";
import { StateError } from "./store.ts";
export const SCHEMA_VERSION = 29;
export const SCHEMA_V1 = `
	CREATE TABLE tickets (
		identity TEXT PRIMARY KEY, state TEXT NOT NULL, work_cycle INTEGER NOT NULL,
		absent INTEGER NOT NULL DEFAULT 0
	);
	CREATE TABLE source_health (
		source_name TEXT PRIMARY KEY, kind TEXT NOT NULL, health TEXT NOT NULL,
		error TEXT, last_success TEXT
	);
	CREATE TABLE memberships (
		source_name TEXT NOT NULL, ticket_identity TEXT NOT NULL, active INTEGER NOT NULL,
		source_kind TEXT NOT NULL, external_key TEXT NOT NULL, source_state TEXT NOT NULL,
		url TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, labels_json TEXT NOT NULL,
		external_updated_at TEXT NOT NULL, repository_identity TEXT NOT NULL,
		repository_display_name TEXT NOT NULL, repository_clone_url TEXT NOT NULL,
		attributes_json TEXT NOT NULL,
		PRIMARY KEY (source_name, ticket_identity),
		FOREIGN KEY (ticket_identity) REFERENCES tickets(identity) ON DELETE CASCADE,
		FOREIGN KEY (source_name) REFERENCES source_health(source_name) ON DELETE CASCADE
	);
	CREATE TABLE handoff_attempts (
		attempt_id TEXT PRIMARY KEY, ticket_identity TEXT NOT NULL, work_cycle INTEGER NOT NULL,
		choice_json TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT,
		failure_reason TEXT,
		FOREIGN KEY (ticket_identity) REFERENCES tickets(identity) ON DELETE CASCADE
	);
	CREATE TABLE handoffs (
		attempt_id TEXT PRIMARY KEY, ticket_identity TEXT NOT NULL, work_cycle INTEGER NOT NULL,
		choice_json TEXT NOT NULL, started_at TEXT NOT NULL,
		FOREIGN KEY (ticket_identity) REFERENCES tickets(identity) ON DELETE CASCADE
	);
	CREATE TABLE lease (
		name TEXT PRIMARY KEY CHECK(name = 'control-plane'), owner_token TEXT NOT NULL,
		pid INTEGER NOT NULL, host TEXT NOT NULL, heartbeat_at INTEGER NOT NULL
	);
	CREATE INDEX memberships_ticket_active ON memberships(ticket_identity, active);
	CREATE INDEX attempts_ticket_open ON handoff_attempts(ticket_identity, resolved_at);
`;
export const MIGRATION_V1_TO_V2 = `
	ALTER TABLE handoffs ADD COLUMN pane_id TEXT;
	ALTER TABLE handoffs ADD COLUMN tab_id TEXT;
	ALTER TABLE handoffs ADD COLUMN workspace_id TEXT;
	CREATE TABLE completion_traces (
		id TEXT PRIMARY KEY,
		handoff_id TEXT NOT NULL,
		ticket_identity TEXT NOT NULL,
		work_cycle INTEGER NOT NULL,
		task_type TEXT NOT NULL,
		agent_type TEXT NOT NULL,
		agent_name TEXT NOT NULL,
		completed_at TEXT NOT NULL,
		last_message TEXT NOT NULL,
		decision TEXT,
		decided_at TEXT,
		FOREIGN KEY (handoff_id) REFERENCES handoffs(attempt_id) ON DELETE CASCADE,
		FOREIGN KEY (ticket_identity) REFERENCES tickets(identity) ON DELETE CASCADE
	);
	CREATE INDEX traces_handoff_pending ON completion_traces(handoff_id, decision);
	CREATE INDEX traces_ticket ON completion_traces(ticket_identity, completed_at);
`;
export const MIGRATION_V2_TO_V3 = "ALTER TABLE completion_traces ADD COLUMN turn_log_json TEXT;";
export const MIGRATION_V3_TO_V4 = `
	CREATE TABLE consultations (
		id TEXT PRIMARY KEY, type_name TEXT NOT NULL, agent_type TEXT NOT NULL,
		environment TEXT NOT NULL, model TEXT NOT NULL, thinking TEXT NOT NULL,
		template TEXT NOT NULL, initial_input TEXT NOT NULL, rendered_opening_prompt TEXT NOT NULL,
		repository_identity TEXT NOT NULL, repository_display_name TEXT NOT NULL,
		repository_clone_url TEXT NOT NULL, repository_path TEXT NOT NULL,
		state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
		agent_name TEXT NOT NULL, pane_id TEXT, tab_id TEXT, workspace_id TEXT, session_id TEXT,
		latest_sequence INTEGER, draft TEXT NOT NULL DEFAULT '', draft_updated_at TEXT,
		draft_old INTEGER NOT NULL DEFAULT 0, failure TEXT, warning TEXT,
		replacement_of TEXT, close_result TEXT, live_conflict_override INTEGER NOT NULL DEFAULT 0,
		attention_at TEXT
	);
	CREATE TABLE consultation_turns (
		id TEXT PRIMARY KEY, consultation_id TEXT NOT NULL, input TEXT NOT NULL,
		accepted_at TEXT NOT NULL, sequence_baseline INTEGER, settled_at TEXT,
		settled_status TEXT, snapshot_id TEXT,
		FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
	);
	CREATE TABLE consultation_snapshots (
		id TEXT PRIMARY KEY, consultation_id TEXT NOT NULL, turn_id TEXT,
		text TEXT NOT NULL, captured_at TEXT NOT NULL, partial INTEGER NOT NULL DEFAULT 0,
		truncated INTEGER NOT NULL DEFAULT 0,
		FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE,
		FOREIGN KEY (turn_id) REFERENCES consultation_turns(id) ON DELETE SET NULL
	);
	CREATE UNIQUE INDEX consultation_turn_snapshot ON consultation_snapshots(turn_id) WHERE turn_id IS NOT NULL AND partial = 0;
	CREATE TABLE consultation_resources (
		consultation_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
		owned INTEGER NOT NULL, confirmed_closed INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (consultation_id, kind, resource_id),
		FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
	);
	CREATE TABLE consultation_remaining_resources (
		consultation_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
		details TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (consultation_id, kind, resource_id),
		FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
	);
	CREATE INDEX consultations_state_attention ON consultations(state, attention_at, updated_at);
	CREATE INDEX consultation_turns_consultation ON consultation_turns(consultation_id, accepted_at);
	CREATE INDEX consultation_snapshots_consultation ON consultation_snapshots(consultation_id, captured_at);
`;
export const MIGRATION_V4_TO_V5 = `
	CREATE TABLE consultation_pending_responses (
		id TEXT PRIMARY KEY, consultation_id TEXT NOT NULL UNIQUE, input TEXT NOT NULL,
		sequence_baseline INTEGER, created_at TEXT NOT NULL,
		FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE
	);
`;
export const MIGRATION_V5_TO_V6 = `
	ALTER TABLE handoffs ADD COLUMN leftover_reason TEXT;
	ALTER TABLE handoffs ADD COLUMN leftover_at TEXT;
	ALTER TABLE handoffs ADD COLUMN leftover_cleared_at TEXT;
	ALTER TABLE handoffs ADD COLUMN herdr_name TEXT;
`;
export const MIGRATION_V6_TO_V7 = `
	ALTER TABLE completion_traces ADD COLUMN model TEXT NOT NULL DEFAULT '';
	ALTER TABLE completion_traces ADD COLUMN thinking TEXT NOT NULL DEFAULT '';
`;
export const MIGRATION_V7_TO_V8 = `
	ALTER TABLE completion_traces ADD COLUMN context_window TEXT NOT NULL DEFAULT '';
	ALTER TABLE consultations ADD COLUMN context_window TEXT NOT NULL DEFAULT '';
`;
export const MIGRATION_V8_TO_V9 = `
	ALTER TABLE completion_traces ADD COLUMN cause TEXT;
	ALTER TABLE completion_traces ADD COLUMN detail TEXT;
	ALTER TABLE consultation_turns ADD COLUMN cause TEXT;
	ALTER TABLE consultation_turns ADD COLUMN detail TEXT;
`;
export const MIGRATION_V9_TO_V10 = `
	ALTER TABLE consultations DROP COLUMN live_conflict_override;
	CREATE TABLE checkout_conflict_confirmations (
		checkout_path TEXT PRIMARY KEY,
		identities_json TEXT NOT NULL,
		confirmed_at TEXT NOT NULL
	);
`;
export const MIGRATION_V10_TO_V11 = `ALTER TABLE tickets ADD COLUMN priority_override TEXT;`;
export const MIGRATION_V11_TO_V12 = `
	CREATE TABLE referenced_issues (
		identity TEXT PRIMARY KEY,
		labels_json TEXT NOT NULL,
		fetched_at TEXT NOT NULL
	);
`;
export const MIGRATION_V12_TO_V13 = `
	CREATE TABLE auto_handoff_mode (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		enabled INTEGER NOT NULL
	);
	INSERT INTO auto_handoff_mode(id, enabled) VALUES (1, 0);
`;
export const WORK_QUEUE_TABLE = `
	CREATE TABLE work_queue (
		position INTEGER PRIMARY KEY,
		ticket_identity TEXT NOT NULL UNIQUE,
		origin TEXT NOT NULL,
		choice_json TEXT NOT NULL,
		previous_message TEXT NOT NULL,
		enqueued_at TEXT NOT NULL
	);
`;
export const MIGRATION_V13_TO_V14 = WORK_QUEUE_TABLE;
export const MIGRATION_V16_TO_V17 =
	"ALTER TABLE completion_traces ADD COLUMN transition_json TEXT;";
export const MIGRATION_V17_TO_V18 = "ALTER TABLE work_queue ADD COLUMN route_from_identity TEXT;";
export const MIGRATION_V18_TO_V19 =
	"ALTER TABLE work_queue ADD COLUMN is_automatic INTEGER NOT NULL DEFAULT 0;";
export const MIGRATION_V19_TO_V20_QUEUE_PAUSE = `
	CREATE TABLE queue_pause (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		paused INTEGER NOT NULL
	);
	INSERT INTO queue_pause(id, paused) VALUES (1, 0);
`;
export const MIGRATION_V19_TO_V20_DROP_PRIORITY =
	"ALTER TABLE tickets DROP COLUMN priority_override;";
export const MIGRATION_V19_TO_V20_DROP_REFERENCED = "DROP TABLE referenced_issues;";
export const WORK_QUEUE_COLUMNS_V16 = `
	position INTEGER PRIMARY KEY,
	ticket_identity TEXT UNIQUE,
	consultation_id TEXT UNIQUE,
	origin TEXT,
	choice_json TEXT,
	previous_message TEXT NOT NULL,
	enqueued_at TEXT NOT NULL,
	CHECK ((ticket_identity IS NOT NULL) <> (consultation_id IS NOT NULL))
`;
export const MIGRATION_V15_TO_V16 = `
	CREATE TABLE work_queue_v16 (${WORK_QUEUE_COLUMNS_V16});
	INSERT INTO work_queue_v16(position, ticket_identity, consultation_id, origin, choice_json, previous_message, enqueued_at)
		SELECT position, ticket_identity, NULL, origin, choice_json, previous_message, enqueued_at FROM work_queue;
	DROP TABLE work_queue;
	ALTER TABLE work_queue_v16 RENAME TO work_queue;
`;
export const MIGRATION_V14_TO_V15 = `
	DROP TABLE IF EXISTS work_queue;
	${WORK_QUEUE_TABLE}
`;
export const MIGRATION_V20_TO_V21_GROUPING_AXIS = `
	CREATE TABLE grouping_axis (
		section TEXT PRIMARY KEY,
		axis TEXT NOT NULL
	);
	INSERT INTO grouping_axis(section, axis) VALUES ('tickets', 'repository');
`;
export const MIGRATION_V21_TO_V22_IGNORED =
	"ALTER TABLE tickets ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0;";
export const MIGRATION_V21_TO_V22_IGNORED_AT = "ALTER TABLE tickets ADD COLUMN ignored_at TEXT;";
export const MIGRATION_V22_TO_V23_MUTED =
	"ALTER TABLE source_health ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;";
export const MIGRATION_V22_TO_V23_MUTED_AT = "ALTER TABLE source_health ADD COLUMN muted_at TEXT;";
export const MIGRATION_V23_TO_V24_GROUP_ORDER = `
CREATE TABLE group_order(
	section TEXT NOT NULL,
	axis TEXT NOT NULL,
	value TEXT NOT NULL,
	pos INTEGER NOT NULL,
	PRIMARY KEY(section, axis, value)
);
`;
export const MIGRATION_V25_TO_V26_PLANE_ACTION_ATTEMPTS = `
CREATE TABLE IF NOT EXISTS plane_action_attempts (
	id TEXT PRIMARY KEY,
	ticket_identity TEXT NOT NULL,
	task_type TEXT NOT NULL,
	decision TEXT NOT NULL,
	outcome TEXT NOT NULL,
	reason TEXT NOT NULL,
	transition_json TEXT,
	at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plane_action_attempts_ticket ON plane_action_attempts (ticket_identity, at);
`;
export const MIGRATION_V24_TO_V25_QUEUE_ACTION =
	"ALTER TABLE work_queue ADD COLUMN action_task_type TEXT;";
export const MIGRATION_V26_TO_V27_REPOSITORY_INIT = `
CREATE TABLE IF NOT EXISTS repository_init (
	repository TEXT PRIMARY KEY,
	settings_hash TEXT NOT NULL,
	pushed_commit TEXT NOT NULL,
	at TEXT NOT NULL
);
`;
/**
 * The index behind the newest-attempt read both attempt holds run (ADR 0101).
 * `attempts_ticket_open` serves the in-flight lookup on `resolved_at`, not the
 * newest claim, so without this the read scans the Ticket's attempt rows and
 * sorts them - 4 ms per read on a Ticket carrying 20,000 attempts.
 *
 * The index stands ascending on purpose. The read orders `created_at DESC,
 * rowid DESC`, and SQLite answers that with a backward scan of an ascending
 * index: the implicit rowid term comes out descending too, so a same-millisecond
 * tie lands the later claim first and no temporary B-tree is built. An index on
 * `created_at DESC` cannot serve that tiebreak.
 */
export const MIGRATION_V27_TO_V28_ATTEMPT_LATEST_INDEX =
	"CREATE INDEX IF NOT EXISTS attempts_ticket_latest ON handoff_attempts(ticket_identity, created_at);";
/**
 * The indexes behind the Failed-start park's run read (issue #298, ADR 0106).
 *
 * The run read answers every Ticket in the projection's list in one statement:
 * the newest attempt that is not a failed settle is each Ticket's boundary, and
 * the run is the failed settles claimed after it. The boundary half scans the
 * attempts that reached an Agent, and the count half the attempts that did not,
 * and `attempts_ticket_latest` serves neither on its own: it carries every
 * attempt, so each half re-reads the whole ledger. The two partial indexes split
 * it, and each half walks only the rows its own half of the ledger holds.
 *
 * Both stand on `(ticket_identity)` alone. The index's implicit rowid term is the
 * claim order the run counts, so `MAX(rowid)` of a Ticket's reached attempts, and
 * the count of its failed settles above a rowid, are both answered from the index
 * without a temporary B-tree. On a file holding 201 Tickets, one of them carrying
 * 9,363 attempts, the read costs 1.5 ms with both indexes against 2.2 ms with
 * `attempts_ticket_latest` alone.
 */
export const MIGRATION_V28_TO_V29_FAILED_START_RUN_INDEXES = `
	CREATE INDEX IF NOT EXISTS attempts_ticket_reached ON handoff_attempts(ticket_identity) WHERE stage <> 'failed';
	CREATE INDEX IF NOT EXISTS attempts_ticket_failed ON handoff_attempts(ticket_identity) WHERE stage = 'failed';
`;
export function hasTable(db: Database, name: string): boolean {
	return (
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null
	);
}
export function hasColumn(db: Database, table: string, name: string): boolean {
	return db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, name) != null;
}
export function hasIndex(db: Database, name: string): boolean {
	return (
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) != null
	);
}
export function migrate(db: Database, path: string): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
		const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as {
			version: number;
		} | null;
		const version = row?.version ?? 0;
		if (version > SCHEMA_VERSION)
			throw new StateError(`database ${path} uses newer schema version ${version}`);
		// A database which claims a known version but lacks that version's
		// core aggregate is not a valid state database. Treat it as newer.
		const coreTable = version >= 4 ? "consultations" : "tickets";
		if (version > 0 && !hasTable(db, coreTable))
			throw new StateError(`database ${path} uses newer schema version ${version}`);
		if (version < 1) db.exec(SCHEMA_V1);
		if (version < 2) {
			db.exec(MIGRATION_V1_TO_V2);
			// Legacy `done` means that the Agent settled. Preserve its work
			// cycle and expose the missing Completion decision.
			db.exec("UPDATE tickets SET state = 'awaiting' WHERE state = 'done'");
			// The absent flag only served the old done-cycle bump.
			db.exec("ALTER TABLE tickets DROP COLUMN absent");
		}
		if (version < 3) db.exec(MIGRATION_V2_TO_V3);
		if (version < 4) db.exec(MIGRATION_V3_TO_V4);
		if (version < 5) db.exec(MIGRATION_V4_TO_V5);
		if (version < 6) db.exec(MIGRATION_V5_TO_V6);
		if (version < 7) db.exec(MIGRATION_V6_TO_V7);
		if (version < 8) db.exec(MIGRATION_V7_TO_V8);
		if (version < 9) db.exec(MIGRATION_V8_TO_V9);
		if (version < 10) db.exec(MIGRATION_V9_TO_V10);
		if (version < 11) db.exec(MIGRATION_V10_TO_V11);
		if (version < 12) db.exec(MIGRATION_V11_TO_V12);
		if (version < 13) db.exec(MIGRATION_V12_TO_V13);
		if (version < 14) db.exec(MIGRATION_V13_TO_V14);
		// The v14 number was reused while the queue was new, so the stamp alone
		// cannot tell the two shapes apart. Ask the file: only the table that
		// lacks its `position` column is unreadable, and a sound queue keeps
		// the starts already waiting in it.
		if (version < 15 && !hasColumn(db, "work_queue", "position")) db.exec(MIGRATION_V14_TO_V15);
		if (version < 16) db.exec(MIGRATION_V15_TO_V16);
		// The column may already stand on a file the version stamp alone does
		// not describe (a downgrade left the column in place), so the stamp
		// and the file both get asked before the step runs.
		if (version < 17 && !hasColumn(db, "completion_traces", "transition_json"))
			db.exec(MIGRATION_V16_TO_V17);
		// Ask the file, not the stamp: a build that stamped 18 before its
		// step ran left a file the stamp alone does not describe, and the
		// column missing is the file's own confession. A sound file keeps
		// the column, so the step stays a no-op for it.
		if (!hasColumn(db, "work_queue", "route_from_identity")) db.exec(MIGRATION_V17_TO_V18);
		// Ask the file, not the stamp: the same build-early risk the route
		// column carries, and a sound file keeps the column, so the step
		// stays a no-op for it.
		if (!hasColumn(db, "work_queue", "is_automatic")) db.exec(MIGRATION_V18_TO_V19);
		if (!hasTable(db, "queue_pause")) db.exec(MIGRATION_V19_TO_V20_QUEUE_PAUSE);
		// The axis table is asked for by name, the way the queue pause is: a
		// file the step already seeded keeps its stored answer, and an older
		// file opens grouped at the fresh default, `repository` (ADR 0066;
		// user story 57).
		if (!hasTable(db, "grouping_axis")) db.exec(MIGRATION_V20_TO_V21_GROUPING_AXIS);
		// Ask the file, not the stamp: a re-labeled newer file already lacks
		// the retired column and the referenced-issues table, so each drop
		// runs only when the fact is still present.
		if (hasColumn(db, "tickets", "priority_override")) db.exec(MIGRATION_V19_TO_V20_DROP_PRIORITY);
		if (hasTable(db, "referenced_issues")) db.exec(MIGRATION_V19_TO_V20_DROP_REFERENCED);
		// Ask the file, not the stamp: the same build-early risk the queue's own
		// columns carry, and each half asks on its own, so a file that holds one
		// of the two cells heals the missing half and keeps the other.
		if (!hasColumn(db, "tickets", "ignored")) db.exec(MIGRATION_V21_TO_V22_IGNORED);
		if (!hasColumn(db, "tickets", "ignored_at")) db.exec(MIGRATION_V21_TO_V22_IGNORED_AT);
		// Ask the file, not the stamp: the same build-early risk the ignore's own
		// columns carry, and a sound file keeps the column, so the step stays a
		// no-op for it.
		if (!hasColumn(db, "source_health", "muted")) db.exec(MIGRATION_V22_TO_V23_MUTED);
		if (!hasColumn(db, "source_health", "muted_at")) db.exec(MIGRATION_V22_TO_V23_MUTED_AT);
		// Asked for by name, the way the axis table is: a file the step already
		// ran keeps its stored order, and an older file opens with no order,
		// which the read answers with the axis' default (ADR 0071).
		if (!hasTable(db, "group_order")) db.exec(MIGRATION_V23_TO_V24_GROUP_ORDER);
		// Ask the file, not the stamp: the queue's action cell is asked by
		// column, the way the route's cell is, and the attempt table is
		// asked by name, the way the queue pause is.
		if (!hasColumn(db, "work_queue", "action_task_type"))
			db.exec(MIGRATION_V24_TO_V25_QUEUE_ACTION);
		if (!hasTable(db, "plane_action_attempts")) db.exec(MIGRATION_V25_TO_V26_PLANE_ACTION_ATTEMPTS);
		// Asked for by name, the way the queue pause and the grouping axis are:
		// a file the step already ran keeps its stored init facts, and an older
		// file opens with none, which the read answers as uninit (ADR 0075).
		if (!hasTable(db, "repository_init")) db.exec(MIGRATION_V26_TO_V27_REPOSITORY_INIT);
		// Asked for by name, the way the plane action attempt index is: a file the
		// step already ran keeps its index, and an older file gains it before the
		// first cycle that reads the Ticket's newest attempt (ADR 0101).
		if (!hasIndex(db, "attempts_ticket_latest")) db.exec(MIGRATION_V27_TO_V28_ATTEMPT_LATEST_INDEX);
		// Asked for by name, the way the newest-attempt index is: a file the step
		// already ran keeps its indexes, and an older file gains the two partial
		// indexes before the first cycle that reads a Ticket's run of failed starts
		// (issue #298, ADR 0106).
		if (!hasIndex(db, "attempts_ticket_failed"))
			db.exec(MIGRATION_V28_TO_V29_FAILED_START_RUN_INDEXES);
		// The `queued` state the retired route wait stood in (ADR 0072): a
		// file that still carries it ends those cycles the way a close does -
		// the ticket rests open with the cycle counted once - in one state
		// write, the way the legacy `done` heal ran. The state is unreachable
		// now, so the step is a no-op on a file the new rule wrote.
		db.exec(
			"UPDATE tickets SET state = 'open', work_cycle = work_cycle + 1 WHERE state = 'queued'",
		);
		db.exec("DELETE FROM schema_version");
		db.prepare("INSERT INTO schema_version(version) VALUES (?)").run(SCHEMA_VERSION);
		db.exec("COMMIT");
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw error;
	}
}
