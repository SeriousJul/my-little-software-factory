/**
 * The shared spinner: the animated face a control wears beside its written
 * word while a wait runs.
 *
 * The face is a braille glyph that steps one frame every about 100 ms. It
 * drives itself with its own interval the way the Decision modal's pop-in
 * drives its own progress: the renderer's animation engine is never asked,
 * and the first frame stands on mount, so a frame snapshot taken at the
 * mount reads the first frame and stays stable.
 *
 * The word carries the meaning, the way the shared state words do: the
 * glyph is the motion, and the word is the fact, so the no-color
 * presentation drops the color and removes nothing else. The face paints
 * from the presentation's ink - the Theme the environment resolved, or the
 * no-color presentation - and holds no palette of its own. The surface names
 * the word the face wears; the ticket's Starting window wears `starting`
 * (ADR 0030).
 */
import { createElement } from "@opentui/react";
import { type ReactElement, useEffect, useState } from "react";

import { padToWidth, truncateToWidth } from "../text.ts";
import { type ControlInk, controlInk } from "./presentation.ts";

/** The braille frames the face steps through, in order. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The milliseconds between two frames. */
export const SPINNER_FRAME_MS = 100;

/**
 * The spinner's self-driven frame index.
 *
 * One interval steps the index one frame at a time, wrapping past the last
 * frame back to the first. The index starts at zero, so the mount paints
 * the first frame before any tick can move it.
 */
export function useSpinnerFrame(frameMs: number = SPINNER_FRAME_MS): number {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setFrame((at) => (at + 1) % SPINNER_FRAMES.length), frameMs);
		return () => clearInterval(id);
	}, [frameMs]);
	return frame;
}

/**
 * The face as written text at one frame: the braille glyph, a cell of air,
 * and the word, padded to the width. A slot the face stands in that cannot
 * mount the control paints this string as a plain run and drives its own
 * frame with the shared frames and timing, so the face reads the same in
 * every slot it stands in.
 */
export function spinnerFace(frame: number, word: string, width: number): string {
	const index = ((frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length;
	return padToWidth(truncateToWidth(`${SPINNER_FRAMES[index]} ${word}`, width), width);
}

export interface SpinnerProps {
	/** The written word the face carries beside its glyph. */
	word: string;
	/** The cells the face holds. The surface names the slot the face stands in. */
	width: number;
	/**
	 * The frame the face stands on, for a presentation that names one. The
	 * face drives its own frames otherwise.
	 */
	frame?: number;
	/** The presentation's ink the face paints in. Default: the active control ink. */
	ink?: ControlInk;
}

/**
 * The spinner face: one braille glyph, a cell of air, and the written word.
 *
 * The face is padded to its width, so a slot it stands in keeps its column
 * as the word beside the glyph grows and shrinks.
 */
export function Spinner(props: SpinnerProps): ReactElement {
	const ink = props.ink ?? controlInk();
	const driven = useSpinnerFrame();
	const at = props.frame ?? driven;
	return createElement(
		"text",
		{ fg: ink.detail.fg ?? undefined },
		spinnerFace(at, props.word, props.width),
	);
}
