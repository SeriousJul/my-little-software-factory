/**
 * The shared spinner: the face a control wears beside its written word
 * while a wait runs.
 *
 * The face is a braille glyph that steps one frame every about 100 ms. The
 * frames and the step the face wears are the presentation's, shared with the
 * frame module, which steps the ticket list's face on its own clock (ADR
 * 0149). The `Spinner` control that stands in a slot of its own keeps a
 * self-driven interval: its first frame stands on mount, so a frame
 * snapshot taken at the mount reads the first frame and stays stable, and
 * the renderer's animation engine is never asked.
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
 * The spinner control's self-driven frame index.
 *
 * One interval steps the index one frame at a time, wrapping past the last
 * frame back to the first. The index starts at zero, so the mount paints
 * the first frame before any tick can move it.
 *
 * The slots the `Spinner` control stands in (the detail header, the
 * repository panel, the gallery) take their frame from here, so a slot that
 * paints the face as a mounted control never disagrees on the frames or on
 * their timing. The ticket list's face is not driven from here: the shared
 * frame module steps it on its own clock, sharing the frames and the step
 * (ADR 0149). A slot that owes no motion while no face of its own is on
 * screen passes `active` false: no interval runs, and the frame stands
 * where it last stood.
 */
export function useSpinnerFrame(
	active: boolean = true,
	frameMs: number = SPINNER_FRAME_MS,
): number {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setFrame((at) => (at + 1) % SPINNER_FRAMES.length), frameMs);
		return () => clearInterval(id);
	}, [frameMs, active]);
	return frame;
}

/**
 * The face as written text at one frame: the braille glyph, a cell of air,
 * and the word, padded to the width. A slot that cannot mount the control
 * paints this string as a plain run: the ticket list's face is stepped by
 * the shared frame module on the shared frames and step, and a static
 * presentation names the frame it stands on.
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
