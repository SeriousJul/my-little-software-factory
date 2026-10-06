/**
 * The passive-flush hold and flush (issue #311).
 *
 * A surface takes and releases its key handler in a passive effect, and
 * React's reconciler schedules the flush of the effects a commit queued
 * in two places. The work loop - the commit itself - schedules straight
 * through the scheduler. The passive flush - the effects the commit
 * queued - first passes the reconciler's own seam: while React's internal
 * `actQueue` holds an array, the flush goes into that array instead of
 * onto the scheduler's clock, and React runs it from its own `act`
 * completion. The array is the one state a test owns between the commit
 * and the flush, and this file owns it for the test.
 *
 * `withholdPassiveFlushes` puts the rig's own array in that seam. While
 * the hold stands, every passive flush lands in the rig's array, not on
 * the scheduler's clock: the commit still runs, the frame still draws,
 * and the flush stands pending in the rig's hand. That is the window a
 * loaded runner opened by chance, standing open by design: on the loaded
 * runner the flush landed 2 to 6 ms after the frame the same commit drew,
 * and `closeOverlay` took its key-handler snapshot in that window, so the
 * snapshot held the shell's handlers only, which never leave the bus, and
 * the wait that ends on the snapshot could end on nothing (issue #311).
 *
 * `flushPassiveNow` is the door the fixed wait goes through. It runs
 * whatever the hold keeps and whatever the scheduler still owes at
 * normal priority, in the rig's own turn: the passive effects land now,
 * not when the scheduler next gets a turn. The call walks to a fixpoint,
 * because a commit it lands queues the flush of its own effects, and a
 * flush it runs can queue the update it settles. A flush that already ran
 * guards on what is still pending, so the call is safe on every poll of
 * every wait, hold up or not.
 *
 * The scheduler record the flush leans on: the file also wraps the
 * scheduler's schedule function, which the reconciler takes at its own
 * module init, so the wrap has to stand before the reconciler loads. The
 * `[test] preload` in `bunfig.toml` evaluates this file before every test
 * file's own imports, which is before `@opentui/react` can load it. With
 * no hold up, the wrap hands every callback to the real scheduler at once
 * and records it, so the scheduler's clock runs the world as before and
 * the record keeps what is still owed.
 *
 * The key takes the hold down, runs what it kept, and hands back the
 * count it kept. A hold up on top of a hold, or a key used twice, fails:
 * a doubled hold could no longer say whose flush was whose.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const reactExports = require("react") as {
	__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
		actQueue: Array<() => void> | null;
	};
};
const internals = reactExports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const schedulerExports = require("scheduler") as {
	unstable_scheduleCallback: (
		priority: number,
		callback: unknown,
		options?: unknown,
	) => { id: number };
	unstable_cancelCallback: (task: { id: number }) => void;
	unstable_NormalPriority: number;
};

const realSchedule = schedulerExports.unstable_scheduleCallback;
const realCancel = schedulerExports.unstable_cancelCallback;
const normalPriority = schedulerExports.unstable_NormalPriority;

interface OwedCallback {
	/** The callback wrapped so its own run retires the record. */
	callback: () => void;
	/** The task the scheduler holds, for the take-off the flush makes. */
	task: { id: number };
}

const state = {
	active: false,
	kept: 0,
	/** The array the hold puts in React's seam, while it stands. */
	queue: [] as Array<() => void>,
	/** What the scheduler still owes at the priority the flush reads. */
	owed: new Set<OwedCallback>(),
};

schedulerExports.unstable_scheduleCallback = (priority, callback, options) => {
	if (priority !== normalPriority) {
		return realSchedule(priority, callback, options);
	}
	const owed: OwedCallback = {
		callback: () => {
			state.owed.delete(owed);
			(callback as () => void)();
		},
		task: { id: 0 },
	};
	state.owed.add(owed);
	owed.task = realSchedule(priority, owed.callback, options);
	return owed.task;
};

/**
 * Run the passive flushes that are still pending, in the rig's own turn.
 *
 * The flush runs whatever the hold keeps in its array and whatever the
 * scheduler still owes at the normal priority, and walks to the fixpoint
 * the rounds above name. It takes each owed callback off the scheduler's
 * clock before it runs it, so the callback the run schedules goes through
 * the record again and the next round settles it.
 */
export function flushPassiveNow(): void {
	for (let round = 0; round < 8; round++) {
		let ran = 0;
		const owed = [...state.owed];
		for (const entry of owed) {
			if (!state.owed.has(entry)) continue;
			realCancel(entry.task);
			state.owed.delete(entry);
			entry.callback();
			ran += 1;
		}
		const kept = state.queue.splice(0);
		for (const callback of kept) {
			callback();
			state.kept += 1;
		}
		ran += kept.length;
		if (ran === 0) return;
	}
}

/**
 * Keep every passive flush in the rig's hand, and hand back the key that
 * takes the hold down.
 *
 * The hold puts the rig's array in React's seam, so a scheduled passive
 * flush lands in the array instead of on the scheduler's clock. The work
 * loop is untouched: it schedules straight through the scheduler, and the
 * commit the flush belongs to still runs and still draws its frame. The
 * key takes the array out of the seam, runs what it kept, and hands back
 * the count it kept, so React leaves the test with no flush still held.
 */
export function withholdPassiveFlushes(): () => number {
	if (state.active) {
		throw new Error("withholdPassiveFlushes: a passive-flush hold is already up");
	}
	if (internals.actQueue !== null) {
		throw new Error("withholdPassiveFlushes: an act is open on top of the hold");
	}
	state.active = true;
	internals.actQueue = state.queue;
	let released = false;
	return () => {
		if (released) {
			throw new Error("withholdPassiveFlushes: the key was used twice");
		}
		released = true;
		internals.actQueue = null;
		state.active = false;
		const kept = state.kept;
		state.kept = 0;
		flushPassiveNow();
		return kept;
	};
}
