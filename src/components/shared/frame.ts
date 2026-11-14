/**
 * The frame module: the one clock the control plane's animation frames step on.
 *
 * Two motions tell the operator that work is live: the spinner face that steps
 * beside the written word while a ticket stands in its Starting window, and the
 * pop that carries a modal box to its settled size. Each of them is a frame
 * owner: the surface registers its owner with the fact its frame holds (a frame
 * index, a pop progress) and the paint that writes that fact into the owner's
 * cells. The module owns the clock each owner steps on and the handoff from a
 * tick to a paint: a tick source hands the module a number of elapsed
 * milliseconds, the module advances every owner's clock, and it hands each
 * owner whose fact changed back the paint that writes the new fact.
 *
 * A frame that changes no cell writes no bytes: an idle owner's tick advances
 * its clock and stops, and a plane with no owner registers no tick source and
 * keeps its one-frame-per-commit economy. The renderer adapter is the plane's
 * tick source in production: it asks the renderer for the frame loop on the
 * first owner's arrival and drops the ask on the last owner's departure, so the
 * loop runs only while a face steps or a box pops. The frame rig is the tick
 * source in tests: one named operation hands the module a named number of
 * milliseconds, and the renderer paints the frame the tick writes.
 *
 * The module is the one writer of an owner's per-frame cells: a structural
 * repaint that changes the owner's static facts refreshes the owner through
 * the same paint, so a repaint never paints a stale frame. A surface that owns
 * its own per-frame timer is rejected the way a separate key system or a color
 * table is (ADR 0014, extended by ADR 0149).
 */
import { useEffect, useRef } from "react";

/**
 * The liveness the renderer keeps while a frame owner is active: the plane asks
 * for the frame loop on the first owner and drops the ask on the last. The
 * renderer adapter installs the renderer's own request and drop; the test
 * renderer installs none, so a test plane never runs a free loop.
 */
export interface FrameLiveness {
	/** Ask the renderer to run its frame loop. */
	request(): void;
	/** Drop the plane's ask on the renderer's frame loop. */
	drop(): void;
}

/** One animated surface of the control plane. */
export interface FrameOwner {
	/** The name the owner keeps across the re-registrations of one opening. */
	id: string;
	/** The fact the owner's frame holds at a number of elapsed milliseconds. */
	factAt(elapsedMs: number): number;
	/** Write one fact into the owner's cells. The module is the only writer. */
	paint(fact: number): void;
	/** The rest budget in milliseconds. Omit when the owner rests only on release. */
	restMs?: number;
}

/** The hold on one registered owner. */
export interface FrameOwnerHandle {
	/** Hand the owner the latest static facts and repaint the current fact. */
	refresh(owner: FrameOwner): void;
	/** Release the owner. Its clock goes away with it. */
	release(): void;
}

interface OwnerClock {
	owner: FrameOwner;
	elapsed: number;
	fact: number;
	/** The registration that owns this clock now. */
	token: number;
}

/** The owners the module clocks, by name. */
const clocks = new Map<string, OwnerClock>();
/** The liveness the plane keeps on the renderer, or none. */
let liveness: FrameLiveness | null = null;
/** The registration number a fresh owner registration takes. */
let clockGeneration = 0;

/**
 * Install the liveness the plane keeps on the renderer, or remove it.
 *
 * The renderer adapter installs the renderer's own request and drop on the way
 * in, and removes the liveness on the way out, before it destroys the
 * renderer: the plane never asks a destroyed renderer for its loop.
 */
export function installFrameLiveness(hook: FrameLiveness | null): void {
	liveness = hook;
}

/** Ask the renderer for its frame loop on the first owner's arrival. */
function askLiveness(): void {
	if (clocks.size === 1) liveness?.request();
}

/** Drop the plane's ask on the renderer's frame loop when the last owner goes. */
function dropLiveness(): void {
	if (clocks.size === 0) liveness?.drop();
}

/**
 * Register one frame owner, or hand the owner the latest static facts on a
 * name an opening already holds.
 *
 * A first registration on a name takes the clock at the open: the module paints
 * the owner's opening fact before any tick, so a frame snapshot taken at the
 * open reads the first frame. A re-registration on a held name keeps the
 * clock and repaints the fact it stands on through the new paint, so a
 * structural repaint that changes the static facts (the word, the width, the
 * theme) repaints through the same paint and never paints a stale frame.
 */
export function registerFrameOwner(owner: FrameOwner): FrameOwnerHandle {
	const token = ++clockGeneration;
	const existing = clocks.get(owner.id);
	if (existing !== undefined) {
		existing.owner = owner;
		existing.token = token;
		existing.fact = owner.factAt(existing.elapsed);
		owner.paint(existing.fact);
	} else {
		const clock: OwnerClock = { owner, elapsed: 0, fact: owner.factAt(0), token };
		clocks.set(owner.id, clock);
		owner.paint(clock.fact);
		askLiveness();
	}
	return ownerHandle(owner.id, token);
}

/** The handle one registration holds on its clock, by name and token. */
function ownerHandle(id: string, token: number): FrameOwnerHandle {
	let released = false;
	return {
		refresh(owner: FrameOwner): void {
			if (released) return;
			const clock = clocks.get(id);
			if (clock === undefined || clock.token !== token) return;
			clock.owner = owner;
			clock.fact = owner.factAt(clock.elapsed);
			owner.paint(clock.fact);
		},
		release(): void {
			if (released) return;
			released = true;
			const clock = clocks.get(id);
			if (clock === undefined || clock.token !== token) return;
			clocks.delete(id);
			dropLiveness();
		},
	};
}

/**
 * Hand the module one tick: a number of milliseconds the tick source elapsed
 * since its last tick.
 *
 * The module advances every owner's clock and hands each owner whose fact
 * changed back its paint, so a tick that changes no cell writes no bytes. An
 * owner whose rest budget ran out paints its rest fact and goes: the modal's
 * pop rests in its budget, and the box stands settled when the last step lands.
 * The face has no rest budget: it steps until its window closes.
 *
 * Reports whether any owner painted, so the tick source knows whether a frame
 * followed the tick.
 */
export function tickFrame(deltaMs: number): boolean {
	let painted = false;
	const rested: OwnerClock[] = [];
	for (const clock of clocks.values()) {
		clock.elapsed += deltaMs;
		const rest = clock.owner.restMs;
		if (rest !== undefined && clock.elapsed >= rest) {
			clock.fact = clock.owner.factAt(rest);
			clock.owner.paint(clock.fact);
			rested.push(clock);
			painted = true;
			continue;
		}
		const fact = clock.owner.factAt(clock.elapsed);
		if (fact !== clock.fact) {
			clock.fact = fact;
			clock.owner.paint(fact);
			painted = true;
		}
	}
	if (rested.length > 0) {
		for (const clock of rested) {
			clocks.delete(clock.owner.id);
		}
		dropLiveness();
	}
	return painted;
}

/**
 * Settle every owner that holds a rest budget: paint its rest fact and release
 * it in one step. An owner without a rest budget keeps stepping: the face rests
 * only when its window closes.
 */
export function settleFrames(): void {
	for (const clock of clocks.values()) {
		const rest = clock.owner.restMs;
		if (rest === undefined || clock.elapsed >= rest) continue;
		clock.elapsed = rest;
		clock.fact = clock.owner.factAt(rest);
		clock.owner.paint(clock.fact);
	}
	let settled = false;
	for (const [id, clock] of clocks) {
		if (clock.owner.restMs === undefined) continue;
		clocks.delete(id);
		settled = true;
	}
	if (settled) dropLiveness();
}

/**
 * Release every registered owner at once.
 *
 * The frame rig calls it when a test plane tears down, so a test that ends
 * mid-motion leaves no owner clocking a destroyed renderer. The production
 * plane relies on the surface's unmount: the hook releases the owner the moment
 * the window closes.
 */
export function releaseAllFrameOwners(): void {
	if (clocks.size === 0) return;
	clocks.clear();
	dropLiveness();
}

/**
 * The frame owner one surface registers for one opening.
 *
 * While `active` is true the module clocks the owner: at the open it paints
 * the owner's opening fact, on each tick it hands the owner whose fact changed
 * back its paint, and a rest budget releases the owner when it runs out. While
 * `active` is false the module releases the owner and its clock goes away. On
 * every commit while `active` is true the owner refreshes through the same
 * paint, so a structural repaint that changes the static facts repaints the
 * current fact and never stands on a stale one. The hook releases the owner on
 * unmount, so a surface that unmounts mid-motion returns its liveness with it.
 */
export function useFrameOwner(active: boolean, build: () => FrameOwner): void {
	const buildRef = useRef(build);
	buildRef.current = build;
	const handleRef = useRef<FrameOwnerHandle | null>(null);

	useEffect(() => {
		if (!active) {
			if (handleRef.current !== null) {
				handleRef.current.release();
				handleRef.current = null;
			}
			return;
		}
		if (handleRef.current === null) {
			handleRef.current = registerFrameOwner(buildRef.current());
		} else {
			handleRef.current.refresh(buildRef.current());
		}
	});

	useEffect(() => {
		return () => {
			if (handleRef.current !== null) {
				handleRef.current.release();
				handleRef.current = null;
			}
		};
	}, []);
}
