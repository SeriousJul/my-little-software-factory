/**
 * The grouping aggregate: the facts it answers and the
 * operations it runs. It reaches only the tables its aggregate owns.
 */

import type { GroupedSection, GroupingAxis, SplitGroupingAxis } from "../domain/grouping.ts";
import { DEFAULT_GROUPING_AXIS, isGroupingAxis } from "../domain/grouping.ts";
import type { StateGraph } from "./graph.ts";
import type { StateScope, StateStore } from "./store.ts";
import { StateError } from "./store.ts";
import { TABLES_OWNED } from "./tables.ts";

export interface GroupingAggregate {
	groupingAxis(section: GroupedSection): GroupingAxis;
	setGroupingAxis(section: GroupedSection, axis: GroupingAxis): void;
	groupOrder(section: GroupedSection, axis: SplitGroupingAxis): string[];
	setGroupOrder(section: GroupedSection, axis: SplitGroupingAxis, values: readonly string[]): void;
}

export class GroupingModule implements GroupingAggregate {
	readonly db: StateScope;
	readonly graph: () => StateGraph;
	constructor(store: StateStore, graph: () => StateGraph) {
		this.db = store.scopeOf("grouping", TABLES_OWNED.grouping);
		this.graph = graph;
	}
	groupingAxis(section: GroupedSection): GroupingAxis {
		const row = this.db.prepare("SELECT axis FROM grouping_axis WHERE section = ?").get(section) as
			| { axis: string }
			| undefined;
		return row !== undefined && isGroupingAxis(row.axis) ? row.axis : DEFAULT_GROUPING_AXIS;
	}
	setGroupingAxis(section: GroupedSection, axis: GroupingAxis): void {
		try {
			this.db
				.prepare(
					"INSERT INTO grouping_axis(section, axis) VALUES (?, ?) ON CONFLICT(section) DO UPDATE SET axis = excluded.axis",
				)
				.run(section, axis);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new StateError(`cannot store the grouping axis at ${this.db.path}: ${message}`);
		}
	}
	groupOrder(section: GroupedSection, axis: SplitGroupingAxis): string[] {
		const rows = this.db
			.prepare("SELECT value FROM group_order WHERE section = ? AND axis = ? ORDER BY pos")
			.all(section, axis) as Array<{ value: string }>;
		return rows.map((row) => row.value);
	}
	setGroupOrder(section: GroupedSection, axis: SplitGroupingAxis, values: readonly string[]): void {
		try {
			this.db.transaction(() => {
				this.db
					.prepare("DELETE FROM group_order WHERE section = ? AND axis = ?")
					.run(section, axis);
				const insert = this.db.prepare(
					"INSERT INTO group_order(section, axis, value, pos) VALUES (?, ?, ?, ?)",
				);
				let pos = 0;
				for (const value of values) {
					insert.run(section, axis, value, pos);
					pos += 1;
				}
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new StateError(`cannot store the group order at ${this.db.path}: ${message}`);
		}
	}
}
