/**
 * The renderer adapter (ADR 0145): the one module that owns the renderer
 * and the repaint policy.
 *
 * The entry module stops marking the renderer's private full-repaint flag
 * on every frame. It constructs the renderer through this module and hands
 * the module the frame facts it alone can know: the writes the plane makes
 * on the terminal outside the renderer, a byte-loss signal when one exists,
 * and the blanket force until a byte-loss signal exists. The adapter
 * installs the frame callback that runs the policy, reads the renderer's
 * own events, the resize and the capability answer, as frame facts, and
 * stands in the entry module's shutdown order, so the renderer returns the
 * terminal before the run ends.
 *
 * The policy answers how much of the screen each frame rewrites: the
 * default is the renderer's native diff, which writes only the cells that
 * changed, and a full rewrite stands when a force fact stands - a terminal
 * resize, the renderer's capability answer, output that landed on the
 * terminal outside the renderer and could paint or move a cell, a detected
 * byte-loss signal, or the blanket force. The blanket force stands as an
 * explicit policy input the entry passes on every frame until a byte-loss
 * signal exists, so the screen keeps its recorded insurance against the
 * drift class of OpenTUI issue 1187: every frame rewrites the whole
 * screen, and a lost byte is overwritten within one frame.
 *
 * The renderer's private full-repaint request is the one private this
 * module owns. The renderer exposes no public ask for a full rewrite, so
 * the adapter sets it, and only when the policy answers full. The entry
 * module and the UI module never see it.
 *
 * The lift of the blanket force, when a byte-loss signal stands and a
 * terminal walk verifies it, is the entry module's withdrawal of one fact:
 * it stops passing the blanket force and hands the signal to the adapter,
 * and the policy, which already answers a byte-loss signal like any other
 * force fact, is unchanged by the lift.
 */
import {
	CliRenderEvents,
	type CliRenderer,
	type CliRendererConfig,
	createCliRenderer,
} from "@opentui/core";

/** How much of the screen a frame rewrites. */
export type RewriteScope = "diff" | "full";

/** The frame's facts the repaint policy answers from. */
export interface RepaintFrameFacts {
	/**
	 * The terminal resized since the last frame: the renderer rebuilds its
	 * model of the screen on the resize, so the screen must stand in full.
	 */
	resized: boolean;
	/**
	 * The renderer answered a terminal capability query since the last
	 * frame: its model of the terminal is rebuilt, so the screen must stand
	 * in full.
	 */
	capabilityAnswer: boolean;
	/**
	 * Output landed on the terminal outside the renderer and could paint or
	 * move a cell since the last frame: the renderer's model does not know
	 * the bytes an outside writer put on the screen, so a diff would skip
	 * the cells the writer touched.
	 */
	outsidePaint: boolean;
	/**
	 * A byte-loss signal stands for this frame: the renderer's model of the
	 * screen may be false, so the lost cells are overwritten within one
	 * frame.
	 */
	byteLoss: boolean;
	/**
	 * The blanket force: the entry passes it on every frame until a
	 * byte-loss signal exists (ADR 0145), so the screen keeps its recorded
	 * insurance against the drift class of OpenTUI issue 1187.
	 */
	blanketForce: boolean;
}

/**
 * The repaint policy (ADR 0145): how much of the screen a frame rewrites,
 * as a function of the frame's facts. The default is the renderer's native
 * diff. A force fact stands when the renderer's model of the screen can be
 * wrong, and any one of them forces a full rewrite of the screen.
 */
export function repaintScope(facts: RepaintFrameFacts): RewriteScope {
	if (
		facts.resized ||
		facts.capabilityAnswer ||
		facts.outsidePaint ||
		facts.byteLoss ||
		facts.blanketForce
	) {
		return "full";
	}
	return "diff";
}

/**
 * A write the plane makes on the terminal outside the renderer (ADR 0145).
 * The entry reports it to the adapter as the fact it is.
 *
 * `paint`: the write could paint or move a cell. The renderer's model of
 * the screen does not know its bytes, so the next frame takes a full
 * rewrite.
 * `bell`: the plane's bell on a Fault. It paints no cell and moves no
 * cursor, so it forces no rewrite of the renderer's next frame.
 */
export type OutsideTerminalWrite = { kind: "paint" } | { kind: "bell" };

/**
 * The renderer's private full-repaint request, as it stands in the
 * installed renderer (0.5.11): a boolean the render path clears when it
 * runs the full rewrite. The renderer exposes no public ask for a full
 * rewrite, which is why the owner of the policy is the one who sets it.
 */
interface FullRepaintRequest {
	forceFullRepaintRequested?: boolean;
}

/**
 * The frame side of the repaint policy: the record of the scope the policy
 * last answered, and the report the entry makes of the plane's writes on
 * the terminal outside the renderer.
 */
export interface RepaintPolicyHandle {
	/**
	 * The rewrite scope the policy answered on the frame it applied last,
	 * read through the adapter's own interface, never through the
	 * renderer's private.
	 */
	readonly lastRewriteScope: RewriteScope;
	/** Report a write the plane makes on the terminal outside the renderer. */
	reportOutsideTerminalWrite(write: OutsideTerminalWrite): void;
}

/** The policy's entry-side facts, read at the frame, not held per frame. */
export interface RepaintPolicyOptions {
	/**
	 * The blanket force (ADR 0145): the entry passes it on every frame
	 * until a byte-loss signal exists, so the policy answers a full
	 * rewrite on every frame and the screen keeps its insurance on the
	 * drift class of OpenTUI issue 1187.
	 */
	blanketForce?: () => boolean;
	/**
	 * The byte-loss signal the entry hands over when one exists: a
	 * detection of the drift class of OpenTUI issue 1187 in a release of
	 * OpenTUI the plane installs, or a terminal-level probe the plane can
	 * read. While none stands, the entry keeps passing the blanket force
	 * instead.
	 */
	byteLossSignal?: () => boolean;
}

/**
 * Stand the repaint policy on a renderer: the frame callback that runs the
 * policy, and the renderer's own events read as frame facts. The resize
 * event and the capability answer stand in the policy's fact set, and the
 * external output the renderer detects, in its capture-stdout mode, joins
 * the outside paint the entry reports.
 *
 * The renderer's own model-rebuild on the resume from suspend stands
 * inside the renderer: it exposes no event for it, so the policy cannot
 * read it as a fact. The renderer forces the full rewrite on that frame on
 * its own, and the fact set of this module stands beside it.
 */
export function installRepaintPolicy(
	renderer: CliRenderer,
	options: RepaintPolicyOptions = {},
): RepaintPolicyHandle {
	let resized = false;
	let capabilityAnswer = false;
	let outsidePaint = false;
	let lastRewriteScope: RewriteScope = "diff";

	renderer.on(CliRenderEvents.RESIZE, () => {
		resized = true;
	});
	renderer.on(CliRenderEvents.CAPABILITIES, () => {
		capabilityAnswer = true;
	});
	renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, () => {
		outsidePaint = true;
	});

	renderer.setFrameCallback(async () => {
		const scope = repaintScope({
			resized,
			capabilityAnswer,
			outsidePaint,
			byteLoss: options.byteLossSignal?.() ?? false,
			blanketForce: options.blanketForce?.() ?? false,
		});
		lastRewriteScope = scope;
		if (scope === "full") {
			// The one private this module owns, set only when the policy
			// answers full.
			(renderer as unknown as FullRepaintRequest).forceFullRepaintRequested = true;
		}
		// The force facts are consumed by the frame they forced: the next
		// frame answers from its own facts.
		resized = false;
		capabilityAnswer = false;
		outsidePaint = false;
	});

	return {
		get lastRewriteScope() {
			return lastRewriteScope;
		},
		reportOutsideTerminalWrite(write: OutsideTerminalWrite): void {
			// The bell paints no cell and moves no cursor, so it stands in
			// the fact set as the fact it is and forces no rewrite.
			if (write.kind === "paint") {
				outsidePaint = true;
			}
		},
	};
}

export interface RendererAdapterOptions extends RepaintPolicyOptions {
	/**
	 * The renderer options the entry stands today: the terminal the entry
	 * runs on, no exit on Ctrl+C, mouse reporting, and the kitty keyboard
	 * names that back the Agent interaction mode's exits.
	 */
	rendererConfig: CliRendererConfig;
}

/**
 * The renderer adapter (ADR 0145): the one module that owns the renderer.
 * The entry constructs it from its boot facts, mounts the App on its
 * renderer, and stands its destroy in the run's shutdown order, so the
 * renderer returns the terminal before the run ends.
 */
export interface RendererAdapter {
	/** The renderer the adapter owns. The entry mounts the App on it. */
	readonly renderer: CliRenderer;
	/** The rewrite scope the policy answered on the frame it applied last. */
	readonly lastRewriteScope: RewriteScope;
	/** Report a write the plane makes on the terminal outside the renderer. */
	reportOutsideTerminalWrite(write: OutsideTerminalWrite): void;
	/** Return the terminal before the run ends. */
	destroy(): void;
}

/**
 * Construct the renderer from the entry's boot facts and stand the repaint
 * policy on it.
 */
export async function createRendererAdapter(
	options: RendererAdapterOptions,
): Promise<RendererAdapter> {
	const renderer = await createCliRenderer(options.rendererConfig);
	const policy = installRepaintPolicy(renderer, options);
	return {
		renderer,
		get lastRewriteScope() {
			return policy.lastRewriteScope;
		},
		reportOutsideTerminalWrite: policy.reportOutsideTerminalWrite,
		destroy(): void {
			renderer.destroy();
		},
	};
}
