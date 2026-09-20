/**
 * The shared control gallery: every shared control, in every state it draws.
 *
 * The gallery is a real application run against the production modules, not a
 * picture of them. It opens on the first example and answers the keys the
 * control plane answers with, so a contributor can exercise a field's caret,
 * paste, focus, and refusal before wiring it into a screen, and an automated
 * test can drive the same example the operator sees.
 *
 * Each example names its own state, because the standard requires the gallery to
 * show a control normal, focused, invalid, unavailable, loading, and narrow: an
 * example that only looks like the happy path teaches nothing about the edge
 * that made the control worth sharing.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useRef, useState } from "react";
import { type Ticket, UNRANKED_PRIORITY } from "../../domain/ticket.ts";
import type { Consultation, WorkQueueItem } from "../../state.ts";
import { currentThemeResolution } from "../../theme-source.ts";
import { ActionBar } from "../action-bar.ts";
import { ActionPanel } from "../action-panel.ts";
import { consultationClosePanel } from "../consultation-close-panel.ts";
import { ConsultationDetail, consultationDetailLines } from "../consultation-detail.ts";
import { consultationRecoveryPanel } from "../consultation-recovery-panel.ts";
import { useControlDispatch } from "../control-dispatch.ts";
import { type ControlContext, contextFor } from "../controls.ts";
import { type MessageFact, messageRowElement } from "../messages.ts";
import { type ActionRow, MARKER_WIDTH, ModalSurface, modalFrame } from "../modal-chrome.ts";
import { truncateToWidth } from "../text.ts";
import { paint } from "../theme.ts";
import { ticketCloseDialog } from "../ticket-close.ts";
import { KeyGuide } from "../utility.ts";
import { workQueueDetailLines } from "../work-queue-detail.ts";
import { WorkQueueList, type WorkQueueRow } from "../work-queue-list.ts";
import { ActionItem, ChoiceRow } from "./choices.ts";
import { DraftField, type FieldFacts, type FieldHandle, TextField } from "./fields.ts";
import { copySelectionWith } from "./form.ts";
import { controlInk, inkForTheme, NO_COLOR_INK, STATE_WORDS } from "./presentation.ts";
import { SPINNER_FRAMES, Spinner } from "./spinner.ts";
import {
	HERDR_THEME_VERSION,
	resolveTheme,
	THEME_ROLES,
	type ThemeRole,
	unknownThemeWarning,
} from "./theme.ts";
import { TypeAheadRow } from "./type-ahead.ts";

/** One example of the gallery: a title, a state word, and the controls it shows. */
export interface GalleryExample {
	id: string;
	/** What the example is, in the words an operator reads on the row. */
	state: string;
	/**
	 * The example's controls at one set of columns.
	 *
	 * `holds` names the control the example shows focused - one control per
	 * example, because a form owns the keyboard through exactly one slot - and
	 * `inputActive` is whether the gallery's own surface holds the keys, so a
	 * test can draw the focused-capture case without a second implementation.
	 */
	render: (
		columns: GalleryColumns,
		holds: string,
		inputActive: boolean,
		wiring: GalleryFieldWiring,
	) => ReactElement[];
	/** Whether this example is drawn at a narrow terminal. */
	narrow?: boolean;
	/**
	 * The rows this example's frame holds, when it needs more than the
	 * gallery's shared frame.
	 *
	 * The shared frame sizes the list and field examples, and an example
	 * that needs a taller box pays for it here instead of raising the frame
	 * every other example renders in: the dialog examples hold a full
	 * confirmation box, which the list rows do not.
	 */
	rows?: number;
}

/**
 * What the gallery hands a field example.
 *
 * One example shows one focused control, as a form holds: the focused field
 * gets the gallery's handle, so Copy selection reaches it, and its fact
 * reports keep the Action bar's Copy control honest.
 */
export interface GalleryFieldWiring {
	/** The gallery's field handle: the focused field's selection and copy. */
	fieldRef: { current: FieldHandle | null };
	/** Every fact report from the focused field: the bar tracks its selection. */
	report: (facts: FieldFacts) => void;
}

/** The columns one example lays its controls out in. */
export interface GalleryColumns {
	contentWidth: number;
	labelWidth: number;
	valueWidth: number;
}

/** The control each example shows focused: one per example, as a form holds. */
const FOCUSED_CONTROL: Record<string, string> = {
	fields: "context",
	states: "launch",
	search: "type-ahead",
	notes: "reason",
	priority: "rank",
	narrow: "draft",
	"no-color": "no-color-repository",
	"theme-light": "light-model",
};

/**
 * The light theme the gallery's light example shows.
 *
 * It is resolved by the same pure rules the startup resolution runs - a light
 * name in herdr's config, read exactly the way herdr reads it - so the
 * example cannot drift from what the plane inherits.
 */
const GALLERY_LIGHT_THEME = resolveTheme('[theme]\nname = "catppuccin-latte"\n', true).theme;

/** The base theme the override example names, and the token values its [theme.custom] section holds. */
const GALLERY_OVERRIDE_BASE = "catppuccin";
const GALLERY_OVERRIDE_TOKENS: ReadonlyArray<readonly [ThemeRole, string]> = [
	["accent", "#ffb86c"],
	["text", "rgb(255, 255, 255)"],
	["panel_bg", "reset"],
];

/**
 * The config the gallery's override example states, and the theme it resolves.
 *
 * The config text and the example's heading line both build from these same
 * tokens, so a change to the config shows in both.
 */
const GALLERY_OVERRIDE_CONFIG = [
	"[theme]",
	`name = "${GALLERY_OVERRIDE_BASE}"`,
	"",
	"[theme.custom]",
	...GALLERY_OVERRIDE_TOKENS.map(([token, value]) => `${token} = "${value}"`),
].join("\n");
const GALLERY_OVERRIDE_THEME = resolveTheme(GALLERY_OVERRIDE_CONFIG, true).theme;

/** One role's swatch: the role's color under the role's name. */
function themeSwatchRow(theme: { roles: Record<ThemeRole, string> }): ReactElement {
	return createElement(
		"text",
		{ key: "swatches" },
		...THEME_ROLES.map((role) =>
			createElement(
				"span",
				{
					key: role,
					// A role the theme resolves to `reset` paints the terminal's
					// own default: the name stands without a swatch.
					bg: theme.roles[role] === "reset" ? undefined : theme.roles[role],
				},
				` ${role}  `,
			),
		),
	);
}

/**
 * The ink an example's own theme wears on its heading row: its text role on
 * its panel surface. A role that resolves to `reset` paints no color, so the
 * terminal's own default shows through where the theme says so.
 */
function exampleHeadingInk(theme: { roles: Record<ThemeRole, string> }): {
	fg: string | undefined;
	bg: string | undefined;
} {
	return {
		fg: theme.roles.text === "reset" ? undefined : theme.roles.text,
		bg: theme.roles.panel_bg === "reset" ? undefined : theme.roles.panel_bg,
	};
}

/** The Model list the Type-ahead examples search. */
export const GALLERY_MODELS = [
	"anthropic/claude-sonnet-4-5",
	"openai/gpt-5.1",
	"openai/gpt-5.1-codex",
];

/** The columns one terminal width gives the gallery. */
export function galleryColumns(contentWidth: number): GalleryColumns {
	const labelWidth = Math.min(14, Math.max(1, contentWidth - 12));
	return {
		contentWidth,
		labelWidth,
		valueWidth: Math.max(1, contentWidth - labelWidth - MARKER_WIDTH),
	};
}

/**
 * The examples the gallery shows, in the order Tab walks them.
 *
 * One entry per state the standard names, so the list is also the checklist a
 * review reads: normal, focused, invalid, unavailable, loading, and narrow.
 */
/** The Consultation the detail and close-dialog examples render under. */
function sampleConsultation(
	state:
		| "queued"
		| "unscheduled"
		| "opening"
		| "working"
		| "awaiting-response"
		| "missing"
		| "failed"
		| "closing"
		| "closed",
): Consultation {
	const now = "2026-02-17T10:00:00.000Z";
	// A `queued` or an `unscheduled` record holds no environment and no Agent
	// until a start runs (ADR 0034, issue #90, issue #91), so the sample
	// carries no handles: the state word and the handles cannot contradict
	// each other in the gallery.
	const waiting = state === "queued" || state === "unscheduled";
	return {
		id: "c1c1c1c1-1111-4111-8111-111111111111",
		typeName: "Review",
		agentType: "consultation",
		environment: "worktree",
		model: "openai/gpt-5.1",
		thinking: "",
		contextWindow: "",
		template: "",
		initialInput: "review the auth design",
		renderedOpeningPrompt: "",
		repository: {
			identity: "SeriousJul/my-little-software-factory",
			displayName: "my-little-software-factory",
			cloneUrl: "",
			path: "/tmp/my-little-software-factory",
		},
		state,
		createdAt: now,
		updatedAt: now,
		agentName: "consultation-00000000",
		paneId: waiting ? null : "pane-c1",
		tabId: waiting ? null : "tab-ws-new",
		workspaceId: waiting ? null : "ws-new",
		sessionId: waiting ? null : "sess-c1",
		latestSequence: waiting ? null : 1,
		draft: "",
		draftUpdatedAt: null,
		draftOld: false,
		failure: state === "failed" ? "herdr refused the launch" : null,
		warning: state === "missing" ? "the Agent pane is gone" : null,
		replacementOf: null,
		closeResult: null,
		attentionAt: null,
		pendingResponse: null,
		resources: [],
	};
}

/**
 * The production close panel the app opens on one Consultation state, for
 * the close dialog's gallery examples.
 *
 * The panel's title, body, and rows come from the same helper the app's
 * render reads, built from the sample record the example names. A state the
 * helper answers with no panel has no example to draw, so the throw is a
 * contributor error, not a state the gallery can reach.
 */
function closeDialogElement(
	state: "opening" | "working" | "awaiting-response" | "closing",
	key: string,
): ReactElement {
	const panel = consultationClosePanel(sampleConsultation(state));
	if (panel === undefined) throw new Error(`the ${state} Consultation must open a close panel`);
	return createElement(ActionPanel, {
		key,
		message: null,
		inputActive: false,
		title: panel.title,
		bodyLines: panel.bodyLines,
		actions: panel.actions,
		onAction: () => undefined,
		onCancel: () => undefined,
	});
}

/**
 * The production recovery panel the app opens on one Consultation state, for
 * the recovery panel's gallery examples.
 *
 * The example draws the module the screen draws, so the words a reviewer reads
 * here are the words the application writes: a written-out copy of a panel can
 * drift from it, and this one cannot.
 */
function recoveryDialogElement(state: "opening" | "missing" | "failed", key: string): ReactElement {
	const panel = consultationRecoveryPanel(sampleConsultation(state));
	if (panel === undefined) throw new Error(`the ${state} Consultation must open a recovery panel`);
	return createElement(ActionPanel, {
		key,
		message: null,
		inputActive: false,
		title: panel.title,
		bodyLines: panel.bodyLines,
		actions: panel.actions,
		onAction: () => undefined,
		onCancel: () => undefined,
	});
}

/** The Ticket the Ticket-Goto and Ticket-Close examples render under. */
function sampleTicket(
	state: "running" | "awaiting" | "open",
	environment: "worktree" | "live-worktree" = "worktree",
): Ticket {
	const now = "2026-02-17T10:00:00.000Z";
	return {
		identity: "github:github.com:SeriousJul/my-little-software-factory:17",
		title: "Fix the layout math",
		repository: "my-little-software-factory",
		repositoryRef: {
			identity: "github.com/SeriousJul/my-little-software-factory",
			displayName: "my-little-software-factory",
			cloneUrl: "",
		},
		state,
		handoff:
			state === "open"
				? null
				: {
						agentType: "pi",
						environment,
						taskType: "implement",
						model: "",
						thinking: "",
						contextWindow: "",
						attemptId: "attempt-t1",
						paneId: "pane-t1",
						tabId: "tab-ws-t",
						workspaceId: "ws-t",
					},
		workCycle: 1,
		handoffCount: 1,
		// An `awaiting` Ticket holds the settled turn the Close decision records
		// on, so the confirmation's first line can name the turn that settled.
		lastCompletion:
			state === "awaiting"
				? {
						taskType: "implement",
						agentType: "pi",
						agentName: "fix-the-layout-math",
						model: "",
						thinking: "",
						contextWindow: "",
						completedAt: now,
						message: "The turn is done.",
						turnLog: [{ kind: "text", text: "The turn is done." }],
						cause: "completed",
						detail: "",
						decision: null,
					}
				: null,
		description: "",
		sourceKind: "github-issue",
		externalKey: "17",
		sourceState: "open",
		url: "",
		labels: [],
		externalUpdatedAt: now,
		memberships: [],
		suggestedTaskType: "implement",
		actionable: true,
		handoffRecoveryRequired: false,
		leftover: null,
		priority: UNRANKED_PRIORITY,
	};
}

/** The Ticket-base-mode context the Ticket-Goto example runs on (ADR 0033). */
function ticketGotoContext(paneAlive: boolean): ControlContext {
	return contextFor(paneAlive ? "ticket-detail" : "ticket-list", {
		selectedTicket: sampleTicket(paneAlive ? "running" : "open"),
		listCanMove: true,
		detailCanScroll: true,
		sourceCount: 0,
		refreshingSourceCount: 0,
		ticketPaneAlive: paneAlive,
		handoffActive: false,
		messageTruncated: false,
		consultationTypesConfigured: true,
	});
}

/** The Consultation-detail context the Goto example runs on. */
function gotoContext(paneAlive: boolean): ControlContext {
	return contextFor("consultation-detail", {
		selectedConsultation: sampleConsultation("working"),
		listCanMove: true,
		detailCanScroll: true,
		sourceCount: 0,
		refreshingSourceCount: 0,
		consultationPaneAlive: paneAlive,
		handoffActive: false,
		messageTruncated: false,
		consultationTypesConfigured: true,
	});
}

export const GALLERY_EXAMPLES: readonly GalleryExample[] = [
	{
		id: "fields",
		state: "normal and focused",
		render: (columns, holds, inputActive, wiring) => [
			createElement(TextField, {
				key: "model",
				label: "Model",
				value: "openai/gpt-5.1",
				focused: holds === "model",
				inputActive,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				hint: "a Text field: one line, Enter submits",
			}),
			createElement(TextField, {
				key: "context",
				label: "Context",
				value: "272000",
				focused: holds === "context",
				inputActive,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				digits: true,
				refusals: {
					character: "This field takes digits only",
					paste: "This field takes digits only: the pasted text was refused as a whole",
				},
				hint: "the focused field: digits only, a paste is refused whole",
				...(holds === "context" ? { fieldRef: wiring.fieldRef, onValueChange: wiring.report } : {}),
			}),
			createElement(DraftField, {
				key: "draft",
				label: "Initial input",
				value: "first line of a draft\nsecond line stays",
				focused: holds === "draft",
				inputActive,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				height: 3,
				hint: "a Draft field: Enter adds a line, an action sends it",
				...(holds === "draft" ? { fieldRef: wiring.fieldRef, onValueChange: wiring.report } : {}),
			}),
		],
	},
	{
		id: "states",
		state: "invalid, unavailable, and loading",
		render: (columns, holds, _inputActive, _wiring) => [
			createElement(TextField, {
				key: "invalid",
				label: "Context",
				value: "0",
				focused: holds === "invalid",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				error: "0 is not a positive whole number of tokens in digits",
			}),
			createElement(ChoiceRow, {
				key: "unavailable",
				label: "Repository",
				value: "",
				focused: holds === "unavailable",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				placeholder: STATE_WORDS.unavailable,
				error: "no verified Repository is available",
			}),
			createElement(ChoiceRow, {
				key: "loading",
				label: "Model",
				value: "",
				focused: holds === "loading",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				placeholder: STATE_WORDS.loading,
			}),
			createElement(
				"box",
				{ key: "actions", style: { flexDirection: "column" } },
				createElement(ActionItem, {
					row: { key: "launch", label: "Launch Consultation" } satisfies ActionRow,
					focused: holds === "launch",
					width: columns.contentWidth,
					refusal: "initial input cannot be empty",
				}),
			),
		],
	},
	{
		id: "search",
		state: "Type-ahead search",
		render: (columns, holds, inputActive, wiring) => [
			createElement(GalleryTypeAhead, {
				key: "type-ahead",
				initial: "openai/gpt-5.1",
				focused: holds === "type-ahead",
				inputActive,
				fieldRef: wiring.fieldRef,
				onFieldFacts: wiring.report,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
			}),
		],
	},
	{
		id: "notes",
		state: "a written reason wider than its column, and a waiting row",
		render: (columns, holds, _inputActive, _wiring) => {
			// The panel's own geometry: a value column narrower than the box,
			// and a written reason the surface cuts at its own width, so a
			// sentence wider than the column stays whole at the width the
			// panel names.
			const valueWidth = Math.min(columns.valueWidth, 30);
			return [
				createElement(ChoiceRow, {
					key: "reason",
					label: "Model",
					value: "openai/gpt-5.1-codex",
					focused: holds === "reason",
					width: valueWidth,
					labelWidth: columns.labelWidth,
					warning: true,
					error:
						`agent "codex" (cli) has no model "openai/gpt-5.1-codex": ` +
						`check the model id and its provider auth`,
					noteWidth: columns.contentWidth,
				}),
				createElement(ChoiceRow, {
					key: "waiting",
					label: "Model",
					value: "anthropic/claude-sonnet-4-5",
					focused: holds === "waiting",
					width: valueWidth,
					labelWidth: columns.labelWidth,
					muted: true,
				}),
			];
		},
	},
	{
		// The shared spinner (ADR 0030): the animated face a control wears
		// beside its written word while a wait runs. The example shows the face
		// the ticket's Starting window wears - the word `starting` beside the
		// braille glyph that steps one frame every about 100 ms. The face drives
		// itself; the word is the fact, so the no-color presentation keeps it.
		id: "spinner",
		state: "the spinner: the loading face beside its written word",
		render: (columns, _holds, _inputActive, _wiring) => [
			createElement(Spinner, {
				key: "starting",
				word: "starting",
				// The cells the ticket row's state badge slot holds, so the face
				// the reviewer sees here is the face the row will wear.
				width: 12,
			}),
			createElement(
				"text",
				{ key: "spinner-frames", fg: paint("subtext0") },
				truncateToWidth(
					`the face steps through: ${SPINNER_FRAMES.join(" ")}`,
					columns.contentWidth,
				),
			),
			createElement(
				"text",
				{ key: "spinner-note", fg: paint("subtext0") },
				truncateToWidth(
					"one frame every 100 ms; the face drives itself; the word keeps the meaning when the color drops",
					columns.contentWidth,
				),
			),
		],
	},
	{
		id: "priority",
		state:
			"the ticket priority: the rank badge, the selector in each state, and the Consultation reason",
		render: (columns, holds, _inputActive, _wiring) => {
			const ink = controlInk();
			// One ticket row per state of the rank badge: the one-cell digit, 1
			// highest, and an unranked ticket that shows no digit at all.
			const badge = (key: string, digit: string | null, title: string) =>
				createElement(
					"box",
					{ key, style: { flexDirection: "row", height: 1 } },
					createElement(
						"text",
						{ fg: digit === null ? undefined : (ink.detail.fg ?? undefined) },
						digit === null ? "   " : `${digit}  `.slice(0, 4),
					),
					createElement("text", { fg: ink.text.fg ?? undefined }, title),
				);
			return [
				badge("rank-1", "1", "critical fix"),
				badge("rank-3", "3", "routine backlog"),
				badge("rank-none", null, "unranked ticket shows no digit"),
				// The detail pane's selector on the standard choice row: a rank,
				// off, and default (clears the override back to the source). The
				// keys step the row to the next value, and the step writes what
				// it shows, so one press stores a rank, off, or the clear.
				createElement(ChoiceRow, {
					key: "rank",
					label: "Override",
					value: "critical",
					focused: holds === "rank",
					width: columns.valueWidth,
					labelWidth: columns.labelWidth,
					hint: "→/l steps the value and writes it: a rank, off, or default",
				}),
				createElement(ChoiceRow, {
					key: "off",
					label: "Override",
					value: "off",
					focused: holds === "off",
					width: columns.valueWidth,
					labelWidth: columns.labelWidth,
				}),
				createElement(ChoiceRow, {
					key: "default",
					label: "Override",
					value: "",
					focused: holds === "default",
					width: columns.valueWidth,
					labelWidth: columns.labelWidth,
					placeholder: "default",
				}),
				// A Consultation selected: the bump is unavailable with its reason.
				createElement(ChoiceRow, {
					key: "consultation",
					label: "Override",
					value: "",
					focused: holds === "consultation",
					width: columns.valueWidth,
					labelWidth: columns.labelWidth,
					placeholder: STATE_WORDS.unavailable,
					error: "a Consultation has no priority: the bump applies to tickets only",
				}),
				// The bump messages the Message line carries, top and floor no-ops
				// included, so a reviewer reads the whole outcome set.
				createElement(
					"text",
					{
						key: "bump-moved",
						style: { width: "100%", height: 1 },
						fg: ink.detail.fg ?? undefined,
					},
					truncateToWidth(
						"bump: + raised to high   - lowered to routine   from the lowest: set to off",
						columns.contentWidth,
					),
				),
				createElement(
					"text",
					{ key: "bump-noop", style: { width: "100%", height: 1 }, fg: ink.detail.fg ?? undefined },
					truncateToWidth(
						"no-op: already at the highest priority   already unranked",
						columns.contentWidth,
					),
				),
			];
		},
	},
	{
		// The Consultation detail's own bodies (ADR 0025): the Session view
		// reads from the Agent's session record, the Agent view is the
		// terminal's pane read when the record does not render yet, and the
		// Captured history stands in once the Consultation is closed and the
		// record reads nothing.
		id: "session-view",
		state: "Session view: the Agent's session record",
		render: (columns, _holds, _inputActive, _wiring) => [
			createElement(ConsultationDetail, {
				key: "session",
				// The pane's own border and padding give the lines a region
				// four cells narrower than the box's content, and the
				// gallery's box holds seven content rows: the sample sits
				// scrolled onto its body, the way the operator reads it.
				lines: consultationDetailLines(
					sampleConsultation("working"),
					[],
					[],
					columns.contentWidth - 4,
					null,
					[
						{ kind: "input", text: "review the auth design" },
						{ kind: "text", text: "The design keeps the session in memory." },
						{ kind: "tool", name: "bash", target: "npm test", failed: false },
						{ kind: "text", text: "All 571 tests pass." },
					],
				),
				visibleRows: 7,
				scroll: 3,
				focused: false,
				bodyTitle: "Session view",
				onFocus: () => undefined,
				onWheel: () => undefined,
			}),
		],
	},
	{
		id: "agent-view-fallback",
		state: "Agent view: the terminal fallback when the record does not read",
		render: (columns, _holds, _inputActive, _wiring) => [
			createElement(ConsultationDetail, {
				key: "agent",
				lines: consultationDetailLines(
					sampleConsultation("working"),
					[],
					[],
					columns.contentWidth - 4,
					"Agent: reading src/auth.ts\nAgent: running the tests",
					null,
				),
				visibleRows: 7,
				scroll: 1,
				focused: false,
				onFocus: () => undefined,
				onWheel: () => undefined,
			}),
		],
	},
	{
		id: "captured-history-fallback",
		state: "Captured history: the closed Consultation's record",
		render: (columns, _holds, _inputActive, _wiring) => [
			createElement(ConsultationDetail, {
				key: "captured",
				lines: consultationDetailLines(
					sampleConsultation("closed"),
					[
						{
							id: "turn-1",
							consultationId: sampleConsultation("closed").id,
							input: "review the auth design",
							acceptedAt: "2026-02-17T10:01:00.000Z",
							sequenceBaseline: 1,
							settledAt: "2026-02-17T10:02:00.000Z",
							settledStatus: "done",
							cause: "completed",
							detail: "",
							snapshotId: "snap-1",
						},
					],
					[
						{
							id: "snap-1",
							consultationId: sampleConsultation("closed").id,
							turnId: "turn-1",
							text: "All 571 tests pass.",
							capturedAt: "2026-02-17T10:02:00.000Z",
							partial: false,
							truncated: false,
						},
					],
					columns.contentWidth - 4,
					null,
					null,
				),
				visibleRows: 7,
				scroll: 3,
				focused: false,
				onFocus: () => undefined,
				onWheel: () => undefined,
			}),
		],
	},
	{
		// The close confirmation opens exactly when a close stops a live
		// Agent. Each of the three live states names its own first line, and
		// the body keeps the worktree and branch whichever state asks. The
		// example draws the production panel the app opens on this state,
		// so the gallery's words are the app's words, not a copy of them.
		id: "close-dialog-opening",
		state: "Close confirmation: the Agent is still opening",
		rows: 17,
		render: (_columns) => [closeDialogElement("opening", "close-opening")],
	},
	{
		id: "close-dialog-working",
		state: "Close confirmation: the Agent is working",
		rows: 17,
		render: (_columns) => [closeDialogElement("working", "close-working")],
	},
	{
		id: "close-dialog-awaiting-response",
		state: "Close confirmation: the Agent waits for your reply",
		rows: 17,
		render: (_columns) => [closeDialogElement("awaiting-response", "close-awaiting")],
	},
	{
		// The closing Consultation opens the recovery panel instead: the
		// cleanup already ran and cannot be confirmed, so the rows offer the
		// retry and the force-close, never the plain close.
		id: "close-panel-closing",
		state: "Close recovery: retry and force-close on a closing",
		rows: 17,
		render: (_columns) => [closeDialogElement("closing", "close-closing")],
	},
	{
		// The Ticket Close confirmation (ADR 0031): key `w` on a ticket with work
		// in flight asks first, and the body names the Agent that is alive and the
		// Environment the Close cleanup ends. The two Environments read
		// differently, so the example shows both.
		id: "ticket-close",
		state: "Ticket Close: the worktree checkout goes, a dirty one stays",
		rows: 17,
		render: (_columns, _holds, _inputActive, _wiring) => [
			createElement(ActionPanel, {
				key: "close-worktree",
				message: null,
				inputActive: false,
				...ticketCloseDialog(sampleTicket("running")),
				onAction: () => undefined,
				onCancel: () => undefined,
			}),
		],
	},
	{
		id: "ticket-close-live-worktree",
		state: "Ticket Close: the live-worktree tab closes, and the turn has settled",
		rows: 17,
		render: (_columns, _holds, _inputActive, _wiring) => [
			createElement(ActionPanel, {
				key: "close-live-worktree",
				message: null,
				inputActive: false,
				...ticketCloseDialog(sampleTicket("awaiting", "live-worktree")),
				onAction: () => undefined,
				onCancel: () => undefined,
			}),
		],
	},
	{
		// Enter on an interrupted opening: the panel offers the retry of the
		// opening this run left behind, and the close that confirms first
		// because the Agent may still be alive.
		id: "recovery-panel-opening",
		state: "Consultation recovery: retry the opening, or close",
		rows: 17,
		render: (_columns) => [recoveryDialogElement("opening", "recovery-opening")],
	},
	{
		// Enter on a missing Agent: no pane and nothing to stop, so the rows
		// are the Replacement that carries this record's context, and the
		// direct close.
		id: "recovery-panel-missing",
		state: "Consultation recovery: replace, or close directly",
		rows: 17,
		render: (_columns) => [recoveryDialogElement("missing", "recovery-missing")],
	},
	{
		// Enter on a failed launch: the same two rows, and the record's own
		// failure under the first line.
		id: "recovery-panel-failed",
		state: "Consultation recovery: a failed launch",
		rows: 17,
		render: (_columns) => [recoveryDialogElement("failed", "recovery-failed")],
	},
	{
		// Goto from either Consultation pane: available while herdr's last
		// poll still reports the Agent's pane alive, unavailable with its
		// own reason when the pane is gone.
		id: "goto",
		state: "Goto: available on an alive Agent pane, unavailable when it is gone",
		render: (columns, _holds, _inputActive, _wiring) => [
			createElement(ActionBar, {
				key: "goto-available",
				mode: "consultation-detail",
				context: gotoContext(true),
				width: columns.contentWidth,
			}),
			createElement(ActionBar, {
				key: "goto-unavailable",
				mode: "consultation-detail",
				context: gotoContext(false),
				width: columns.contentWidth,
			}),
		],
	},
	{
		// Goto from either Ticket pane (ADR 0033): available on an in-flight
		// Ticket with the Agent's pane alive in the last poll, refused on an
		// open Ticket with the Consultation section's own words.
		id: "ticket-goto",
		state: "Ticket Goto: available on an alive pane, refused otherwise",
		render: (columns, _holds, _inputActive, _wiring) => [
			createElement(ActionBar, {
				key: "ticket-goto-available",
				mode: "ticket-detail",
				context: ticketGotoContext(true),
				width: columns.contentWidth,
			}),
			createElement(ActionBar, {
				key: "ticket-goto-unavailable",
				mode: "ticket-list",
				context: ticketGotoContext(false),
				width: columns.contentWidth,
			}),
		],
	},
	{
		// The record the queue's removal leaves behind (issue #91): an
		// `unscheduled` Consultation's own detail. The ask stands on its type,
		// repository, and initial input, and the hint names the three answers the
		// section gives it: schedule it back, start it now over the cap, or delete
		// the record.
		id: "consultation-detail-unscheduled",
		state: "Consultation detail: the unscheduled record and its three answers",
		render: (columns, _holds, _inputActive, _wiring) => [
			createElement(ConsultationDetail, {
				key: "unscheduled",
				lines: consultationDetailLines(
					sampleConsultation("unscheduled"),
					[
						{
							id: "turn-0",
							consultationId: sampleConsultation("unscheduled").id,
							input: "review the auth design",
							acceptedAt: "2026-02-17T10:00:00.000Z",
							sequenceBaseline: null,
							settledAt: null,
							settledStatus: null,
							cause: "completed",
							detail: "",
							snapshotId: null,
						},
					],
					[],
					columns.contentWidth - 4,
					null,
					null,
				),
				visibleRows: 7,
				scroll: 0,
				focused: false,
				onFocus: () => undefined,
				onWheel: () => undefined,
			}),
		],
	},
	{
		// The unscheduled record's three answers in the Consultation section
		// (issue #91): `s` schedules it back into the Work queue, Enter starts
		// it now over the cap, and `d` deletes the record. The bar holds the
		// hints available on the unscheduled record, and the bar of a working
		// record shows none of them: the start and the schedule refuse it in
		// the catalogue's words, and the delete waits for the close.
		id: "consultation-unscheduled-actions",
		state: "Unscheduling: schedule, start now over the cap, or delete the record",
		render: (columns, _holds, _inputActive, _wiring) => {
			const bar = (key: string, state: "unscheduled" | "working") =>
				createElement(ActionBar, {
					key,
					mode: "consultation-list",
					context: contextFor("consultation-list", {
						selectedConsultation: sampleConsultation(state),
						listCanMove: true,
						detailCanScroll: false,
						sourceCount: 0,
						refreshingSourceCount: 0,
						handoffActive: false,
						messageTruncated: false,
						consultationTypesConfigured: true,
						consultationRefreshAvailable: true,
					}),
					width: columns.contentWidth,
				});
			return [
				bar("unscheduled-actions-available", "unscheduled"),
				bar("unscheduled-actions-refused", "working"),
				// The words the three answers leave on the Message line: the
				// schedule's notice, the start's notice over the cap, and the
				// queue removal that created the record's state.
				messageRowElement(
					{
						severity: "info",
						text: "Consultation c1c1c1c1 scheduled: it waits at the end of the Work queue",
					},
					columns.contentWidth,
				),
				messageRowElement(
					{
						severity: "info",
						text: "starting Consultation c1c1c1c1 over the Parallel limit",
					},
					columns.contentWidth,
				),
				messageRowElement(
					{
						severity: "info",
						text: "consultation c1c1c1c1: removed from the queue; the record is unscheduled",
					},
					columns.contentWidth,
				),
			];
		},
	},
	{
		// The record the queue waits on (ADR 0034, issue #90): a `queued`
		// Consultation's own detail, with no Agent output to read and no
		// environment behind it - the state word is the whole fact.
		id: "consultation-detail-queued",
		state: "Consultation detail: the queued record that waits for a seat",
		render: (columns, _holds, _inputActive, _wiring) => [
			createElement(ConsultationDetail, {
				key: "queued",
				lines: consultationDetailLines(
					sampleConsultation("queued"),
					[],
					[],
					columns.contentWidth - 4,
					null,
					null,
				),
				visibleRows: 7,
				scroll: 0,
				focused: false,
				onFocus: () => undefined,
				onWheel: () => undefined,
			}),
		],
	},
	{
		// The Work queue's list (ADR 0034): the rows in the shared order with
		// the origin word and the place - the handoff's origin and the
		// Consultation item's kind (issue #90) - the empty state, and the bar
		// the cursor's own keys come from.
		id: "work-queue",
		state: "the Work queue: the waiting starts in queue order, and the empty state",
		render: (columns, _holds, _inputActive, _wiring) => {
			const items: WorkQueueItem[] = [
				{
					kind: "handoff",
					position: 0,
					ticketIdentity: "github:github.com:SeriousJul/my-little-software-factory#42",
					origin: "open",
					choice: {
						agentType: "pi",
						environment: "worktree",
						taskType: "implement",
						model: "",
						thinking: "",
						contextWindow: "",
					},
					previousMessage: "",
					enqueuedAt: "2026-02-17T10:00:00.000Z",
				},
				{
					kind: "handoff",
					position: 1,
					ticketIdentity: "github:github.com:SeriousJul/my-little-software-factory#43",
					origin: "workflow",
					choice: {
						agentType: "pi",
						environment: "worktree",
						taskType: "implement",
						model: "",
						thinking: "",
						contextWindow: "",
					},
					previousMessage: "the workflow named the next task",
					enqueuedAt: "2026-02-17T10:01:00.000Z",
				},
				// The `queued` Consultation's item (issue #90): the pointer stands
				// in the same order, under its kind word and the record's
				// identity prefix.
				{
					kind: "consultation",
					position: 2,
					consultationId: "c1c1c1c1-1111-4111-8111-111111111111",
					enqueuedAt: "2026-02-17T10:02:00.000Z",
				},
			];
			const rows: WorkQueueRow[] = items.map((item, index) => ({
				item,
				title:
					index === 0
						? "Add a webhook retry policy"
						: index === 1
							? "Close the stale deploy branch"
							: "c1c1c1c1",
			}));
			return [
				createElement(WorkQueueList, {
					key: "queue",
					rows,
					selectedIndex: 0,
					focused: true,
					height: 6,
					onFocus: () => undefined,
					onSelect: () => undefined,
					onMove: () => undefined,
				}),
				createElement(WorkQueueList, {
					key: "queue-empty",
					rows: [],
					selectedIndex: 0,
					focused: false,
					height: 3,
					onFocus: () => undefined,
					onSelect: () => undefined,
					onMove: () => undefined,
				}),
				createElement(ActionBar, {
					key: "queue-bar",
					mode: "work-queue-list",
					context: contextFor("work-queue-list", {
						listCanMove: true,
						detailCanScroll: false,
						selectedWorkQueueItem: items[0],
						workQueueDepth: items.length,
						sourceCount: 0,
						refreshingSourceCount: 0,
						handoffActive: false,
						messageTruncated: false,
						consultationTypesConfigured: true,
					}),
					width: columns.contentWidth,
				}),
			];
		},
	},
	{
		// The force-dispatch from the Work queue (issue #89, ADR 0034): Enter on
		// a queue row starts the item now, over a full Parallel limit. The bar
		// holds the hint available on an item, dimmed while a Handoff runs, and
		// dimmed on an empty queue, and the Message lines carry the words the
		// refusals and the failure leave: the item leaves the queue, and the
		// ticket keeps its state and its own failure surface.
		id: "work-force-dispatch",
		state:
			"Force-dispatch: a Handoff item refuses while a Handoff runs; a Consultation item stands over the cap",
		render: (columns, _holds, _inputActive, _wiring) => {
			const item: WorkQueueItem = {
				kind: "handoff",
				position: 0,
				ticketIdentity: "github:github.com:SeriousJul/my-little-software-factory#42",
				origin: "open",
				choice: {
					agentType: "pi",
					environment: "worktree",
					taskType: "implement",
					model: "",
					thinking: "",
					contextWindow: "",
				},
				previousMessage: "",
				enqueuedAt: "2026-02-17T10:00:00.000Z",
			};
			// The Consultation item's row (issue #90): its force-dispatch runs its
			// own pickup seam and never parks on the herdr seat, so the bar stands
			// on it while a Handoff runs.
			const consultation: WorkQueueItem = {
				kind: "consultation",
				position: 1,
				consultationId: "c1c1c1c1-1111-4111-8111-111111111111",
				enqueuedAt: "2026-02-17T10:01:00.000Z",
			};
			const bar = (key: string, handoffActive: boolean, selected: WorkQueueItem | null) =>
				createElement(ActionBar, {
					key,
					mode: "work-queue-list",
					context: contextFor("work-queue-list", {
						listCanMove: selected !== null,
						detailCanScroll: false,
						selectedWorkQueueItem: selected,
						workQueueDepth: selected === null ? 0 : 1,
						sourceCount: 0,
						refreshingSourceCount: 0,
						handoffActive,
						messageTruncated: false,
						consultationTypesConfigured: true,
					}),
					width: columns.contentWidth,
				});
			return [
				// The hint in its states: available on an item, dimmed while a
				// Handoff holds the environment seat for a Handoff item, standing on
				// a Consultation item in the same moment, and dimmed on an empty
				// queue.
				bar("force-dispatch-available", false, item),
				bar("force-dispatch-busy", true, item),
				bar("force-dispatch-consultation-busy", true, consultation),
				bar("force-dispatch-empty", false, null),
				// The words the refusals carry on the Message line: a refused key
				// says its catalogue reason on the line the operator already
				// watches.
				messageRowElement(
					{ severity: "warning", text: "a Handoff is active" },
					columns.contentWidth,
				),
				messageRowElement(
					{ severity: "warning", text: "no queue item is under the cursor" },
					columns.contentWidth,
				),
				// The failure path: the claim the force-dispatch re-runs refused the
				// start, so the item leaves the queue with this warning, and the
				// ticket keeps its state.
				messageRowElement(
					{
						severity: "warning",
						text: `force-dispatch of "Add a webhook retry policy" failed: only open tickets can be handed off`,
					},
					columns.contentWidth,
				),
				// The Consultation item's force-dispatch over the cap (issue #90):
				// the item leaves the queue, and the line names the cap it stood
				// over. The record's own progress line takes over from there.
				messageRowElement(
					{
						severity: "info",
						text: `force-dispatched Consultation c1c1c1c1 over the Parallel limit`,
					},
					columns.contentWidth,
				),
			];
		},
	},
	{
		// The Consultation item's detail (ADR 0034, issue #90): the record is
		// the ask, and the detail reads the record the item names, so the
		// reviewer sees the pointer's own facts, the record's facts beside
		// them, and the record gone in its place.
		id: "work-queue-item-consultation",
		state: "Work queue item: the Consultation it names",
		render: (_columns, _holds, _inputActive, _wiring) => [
			createElement(ConsultationDetail, {
				key: "work-queue-item-consultation",
				lines: workQueueDetailLines(
					{
						item: {
							kind: "consultation",
							position: 2,
							consultationId: "c1c1c1c1-1111-4111-8111-111111111111",
							enqueuedAt: "2026-02-17T10:02:00.000Z",
						},
						title: "c1c1c1c1",
					},
					3,
					sampleConsultation("queued"),
				),
				visibleRows: 7,
				scroll: 0,
				focused: false,
				onFocus: () => undefined,
				onWheel: () => undefined,
			}),
		],
	},
	{
		id: "work-queue-item-consultation-gone",
		state: "Work queue item: the record it names is gone",
		render: (_columns, _holds, _inputActive, _wiring) => [
			createElement(ConsultationDetail, {
				key: "work-queue-item-consultation-gone",
				lines: workQueueDetailLines(
					{
						item: {
							kind: "consultation",
							position: 2,
							consultationId: "c1c1c1c1-1111-4111-8111-111111111111",
							enqueuedAt: "2026-02-17T10:02:00.000Z",
						},
						title: "c1c1c1c1",
					},
					3,
				),
				visibleRows: 7,
				scroll: 0,
				focused: false,
				onFocus: () => undefined,
				onWheel: () => undefined,
			}),
		],
	},
	{
		id: "theme",
		state: "the inherited theme",
		render: (columns, _holds, _inputActive, _wiring) => {
			const resolution = currentThemeResolution();
			return [
				createElement(
					"text",
					{ key: "theme-name", fg: paint("text") },
					truncateToWidth(
						`theme: ${resolution.theme.name} (${resolution.theme.appearance})  ` +
							`built-in definitions vendored from herdr ${HERDR_THEME_VERSION}`,
						columns.contentWidth,
					),
				),
				themeSwatchRow(resolution.theme),
				createElement(
					"text",
					{ key: "theme-note", fg: paint("subtext0") },
					truncateToWidth(
						"a role that resolves to `reset` shows no swatch: the terminal's default stands",
						columns.contentWidth,
					),
				),
			];
		},
	},
	{
		id: "theme-fallback",
		state: "the fallback warning on the Message line",
		render: (columns, _holds, _inputActive, _wiring) => [
			createElement(
				"text",
				{ key: "fallback-note", fg: paint("subtext0") },
				truncateToWidth(
					"inside herdr, a theme the config cannot name falls back and says so once:",
					columns.contentWidth,
				),
			),
			messageRowElement(
				{ severity: "warning", text: unknownThemeWarning("frobnicate") },
				columns.contentWidth,
			),
		],
	},
	{
		id: "theme-light",
		state: "the light theme: a light name in herdr's config, the same controls in that ink",
		render: (columns, holds, inputActive, wiring) => {
			const ink = inkForTheme(GALLERY_LIGHT_THEME);
			// The heading wears the example's own pair, not the environment's
			// ink, so a light name reads light on any terminal.
			const heading = exampleHeadingInk(GALLERY_LIGHT_THEME);
			return [
				createElement(
					"text",
					{ key: "light-name", fg: heading.fg, bg: heading.bg },
					truncateToWidth(
						`theme: ${GALLERY_LIGHT_THEME.name} (${GALLERY_LIGHT_THEME.appearance})`,
						columns.contentWidth,
					),
				),
				themeSwatchRow(GALLERY_LIGHT_THEME),
				createElement(TextField, {
					key: "light-model",
					label: "Model",
					value: "openai/gpt-5.1",
					focused: holds === "light-model",
					inputActive,
					width: columns.valueWidth,
					labelWidth: columns.labelWidth,
					ink,
					...(holds === "light-model"
						? { fieldRef: wiring.fieldRef, onValueChange: wiring.report }
						: {}),
				}),
			];
		},
	},
	{
		id: "theme-override",
		state: "custom overrides: the per-token [theme.custom] values on top of the base theme",
		render: (columns) => [
			createElement(
				"text",
				// The heading wears the override's own pair: the overridden text
				// role stands, and the panel surface resolves to `reset`.
				{
					key: "override-config",
					...exampleHeadingInk(GALLERY_OVERRIDE_THEME),
				},
				truncateToWidth(
					`[theme] names "${GALLERY_OVERRIDE_BASE}"; [theme.custom] sets ${GALLERY_OVERRIDE_TOKENS.map(
						([token, value]) => `${token} to ${value}`,
					).join(", ")}`,
					columns.contentWidth,
				),
			),
			themeSwatchRow(GALLERY_OVERRIDE_THEME),
			createElement(
				"text",
				{ key: "override-note", fg: paint("subtext0") },
				truncateToWidth(
					"a swatch wears the override where the token holds, and stands without one where the token resolves to `reset`",
					columns.contentWidth,
				),
			),
		],
	},
	{
		id: "no-color",
		state: "the no-color presentation: the same controls, painted with no color",
		render: (columns, holds, inputActive, wiring) => [
			createElement(TextField, {
				key: "no-color-model",
				label: "Model",
				value: "openai/gpt-5.1",
				focused: holds === "no-color-model",
				inputActive,
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				ink: NO_COLOR_INK,
				...(holds === "no-color-model"
					? { fieldRef: wiring.fieldRef, onValueChange: wiring.report }
					: {}),
			}),
			createElement(ChoiceRow, {
				key: "no-color-repository",
				label: "Repository",
				value: "my-little-software-factory",
				focused: holds === "no-color-repository",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				ink: NO_COLOR_INK,
			}),
			// The spinner face in the no-color ink: the written word stands,
			// and the renderer's default shows through where the color would be.
			createElement(Spinner, {
				key: "no-color-starting",
				word: "starting",
				width: 12,
				ink: NO_COLOR_INK,
			}),
			createElement(
				"box",
				{ key: "no-color-actions", style: { flexDirection: "column" } },
				createElement(ActionItem, {
					row: { key: "no-color-launch", label: "Launch Consultation" } satisfies ActionRow,
					focused: holds === "no-color-launch",
					width: columns.contentWidth,
					ink: NO_COLOR_INK,
				}),
			),
		],
	},
	{
		id: "narrow",
		state: "narrow terminal",
		narrow: true,
		render: (columns, holds, _inputActive, wiring) => [
			createElement(TextField, {
				key: "model",
				label: "Model",
				value: "anthropic/claude-sonnet-4-5-with-a-long-tail",
				focused: holds === "model",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
			}),
			createElement(DraftField, {
				key: "draft",
				label: "Initial input",
				value: "a draft wide enough that its own column has to scroll to the caret",
				focused: holds === "draft",
				width: columns.valueWidth,
				labelWidth: columns.labelWidth,
				height: 2,
				...(holds === "draft" ? { fieldRef: wiring.fieldRef, onValueChange: wiring.report } : {}),
			}),
		],
	},
];

/**
 * The gallery's Type-ahead example, with the value the search names.
 *
 * The row is the production module; only the small owner of the selected value
 * is gallery code, because that is the part a screen keeps for itself. A
 * contributor who exercises the search here drives the same callback the
 * override panel wires.
 */
function GalleryTypeAhead(props: {
	initial: string;
	focused: boolean;
	inputActive: boolean;
	fieldRef?: { current: FieldHandle | null };
	/** The focused field's fact reports, for the Action bar's Copy control. */
	onFieldFacts?: (facts: FieldFacts) => void;
	width: number;
	labelWidth: number;
}): ReactElement {
	// The screen owns the value a search names, so the example owns it here: the
	// gallery is the screen in this program, exactly as the panel is in that one.
	const [value, setValue] = useState(props.initial);
	return createElement(TypeAheadRow, {
		label: "Model",
		value,
		options: GALLERY_MODELS,
		focused: props.focused && props.inputActive,
		inputActive: props.inputActive,
		fieldRef: props.fieldRef,
		width: props.width,
		labelWidth: props.labelWidth,
		placeholder: STATE_WORDS.unset,
		onQueryChange: (_query, match, facts) => {
			if (match.first !== undefined) setValue(match.first);
			props.onFieldFacts?.(facts);
		},
	});
}

interface GalleryProps {
	/** The example to open on, so a test or a contributor lands on one state. */
	example?: string;
	/** Take the keys away from the fields, as a surface above them does. */
	inputActive?: boolean;
	onEmergencyExit: () => void;
}

/**
 * The gallery surface: one example at a time, with the shared chrome around it.
 *
 * Tab walks the examples; the surface's own keys come from the same catalogue
 * every control-plane screen uses, so what a contributor exercises here is the
 * dispatch and the Action bar the application runs.
 */
export function Gallery({
	example,
	inputActive = true,
	onEmergencyExit,
}: GalleryProps): ReactElement {
	const { width, height } = useTerminalDimensions();
	const ids = GALLERY_EXAMPLES.map((entry) => entry.id);
	const [index, setIndex] = useState(Math.max(0, ids.indexOf(example ?? ids[0])));
	const indexRef = useRef(index);
	const field = useRef<FieldHandle | null>(null);
	// The focused field's selection, tracked from its own fact reports: the
	// bar's Copy control is available only while a selection exists, and a
	// plain arrow that collapses it must take the control off the bar.
	const [hasSelection, setHasSelection] = useState(false);
	// The outcome of the last Copy selection the operator ran.
	const [message, setMessage] = useState<MessageFact | null>(null);
	const wiring: GalleryFieldWiring = {
		fieldRef: field,
		report: (facts: FieldFacts) => setHasSelection(facts.selection !== ""),
	};
	const ink = controlInk();
	// The Key guide, the shared overlay the Application's F1 opens. While it
	// is open, it owns the keys: the gallery's own dispatch stands down, and
	// the example's fields stay mounted, so closing returns the same field,
	// caret, and selection the operator left.
	const [guideOpen, setGuideOpen] = useState(false);
	const barContext = contextFor("form-field", {
		listCanMove: false,
		detailCanScroll: false,
		sourceCount: 0,
		refreshingSourceCount: 0,
		handoffActive: false,
		messageTruncated: false,
		consultationTypesConfigured: true,
		fieldHasSelection: hasSelection,
	});
	// The gallery's own keys come from the same catalogue the application runs,
	// so a contributor exercises the real dispatch and the real Action bar.
	useControlDispatch({
		mode: "form-field",
		context: barContext,
		onEmergencyExit,
		active: guideOpen === false,
		handlers: {
			help: () => setGuideOpen(true),
			// The gallery is the surface here, so closing its form leaves it the
			// way the application leaves a terminal.
			"close-form": () => onEmergencyExit(),
			"move-field": ({ key }) => {
				const next = (indexRef.current + (key.shift === true ? -1 : 1) + ids.length) % ids.length;
				indexRef.current = next;
				setIndex(next);
				setHasSelection(false);
				setMessage(null);
				key.preventDefault?.();
			},
			// The same shared handler the application's forms run: the gallery's own
			// line is the news line it reports to.
			"copy-selection": copySelectionWith(
				() => field.current,
				(news) => setMessage(news),
			),
		},
	});
	const shown = GALLERY_EXAMPLES[index] ?? GALLERY_EXAMPLES[0];
	const narrow = shown.narrow === true;
	const frame = modalFrame(narrow ? 28 : width, height, {
		rows: shown.rows ?? 12,
		margin: 1,
	});
	const columns = galleryColumns(frame.contentWidth);
	return createElement(
		"box",
		{ style: { width: "100%", height: "100%" } },
		createElement(ModalSurface, {
			frame,
			width: narrow ? 28 : width,
			title: `Shared controls - ${shown.state}`,
			borderColor: ink.indicator.fg ?? paint("accent"),
			minContentRows: 3,
			message,
			bar: { mode: "form-field", context: barContext },
			children: [
				createElement(
					"text",
					{ key: "state", fg: ink.detail.fg ?? undefined },
					truncateToWidth(
						`state: ${shown.state}  (Tab shows the next example; ${ids.length} in all)`,
						frame.contentWidth,
					),
				),
				...shown.render(columns, FOCUSED_CONTROL[shown.id] ?? shown.id, inputActive, wiring),
			],
		}),
		guideOpen &&
			createElement(KeyGuide, {
				message,
				context: barContext,
				onClose: () => setGuideOpen(false),
				onEmergencyExit,
			}),
	);
}
