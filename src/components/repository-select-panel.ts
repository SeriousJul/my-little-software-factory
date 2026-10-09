/**
 * The repository select panel: the list the operator picks the next
 * repository to init from (ADR 0082).
 *
 * The plane opens it on the `o` key from any base pane. It reads the
 * operator's own repositories and the repositories of their organizations
 * from GitHub on the ambient `gh` identity, and it hands the chosen
 * repository to the screen that owns the init. Choosing a repository runs
 * the checkout resolution and the planning the group header's `i` already
 * runs, so the confirmation panel the operator reads next is the one they
 * know.
 *
 * The operator marks rows for the queue with Tab (ADR 0083): a marking of
 * two or more makes Enter run the queue, one repository per confirmation
 * panel, in list order. Anything else is the select of the row under the
 * cursor, the way the panel's single select has always run.
 *
 * Every control comes from the shared library: the search is the shared Text
 * field, the list is the shared region with its wrap and auto-scroll, and the
 * box is the shared modal chrome. The keys dispatch through the catalogue in
 * the repository-select mode: typing edits the search, up and down and j and
 * k move the cursor, Tab marks the row under the cursor for the queue, Enter
 * selects the row under the cursor or starts the queue, Del clears the
 * search, Esc closes, and the catalogue names them on the Action bar.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { InitableRepository } from "../repository-list.ts";
import { type ControlHandler, useControlDispatch } from "./control-dispatch.ts";
import { availabilityFacts, type StandingFacts } from "./controls.ts";
import type { MessageFact } from "./messages.ts";
import { type ActionRow, MARKER_WIDTH, ModalSurface, modalFrame } from "./modal-chrome.ts";
import { TextField } from "./shared/fields.ts";
import { controlInk } from "./shared/presentation.ts";
import { useDecisionRegion } from "./shared/region.ts";
import { Spinner } from "./shared/spinner.ts";
import { padToWidth, truncateToWidth } from "./text.ts";

/** What the panel stands on: the read in flight, its failure, or its list. */
export type RepositorySelectStatus =
	| { state: "loading" }
	| { state: "error"; reason: string }
	| { state: "ready"; repositories: readonly InitableRepository[] };

interface RepositorySelectPanelProps {
	/** The one read the panel stands on, handed in by the screen that owns it. */
	fetchRepositories: () => Promise<
		| { status: "success"; repositories: readonly InitableRepository[] }
		| { status: "failed"; reason: string }
	>;
	/** The queue the Enter hands over: the marked rows, or the cursor's row. */
	onSelect: (queue: readonly InitableRepository[]) => void;
	/** The rows a presentation arrives with marked, for the queue's badge. */
	initialPending?: readonly string[];
	onCancel: () => void;
	/** The base control facts, preserved while this panel owns input. */
	/** The plane's standing facts, read the same way in every mode. */
	standing: StandingFacts;
	/** False while a Key guide or Message view is above this panel. */
	inputActive?: boolean;
	/** Open the Key guide on the mode this panel is running. */
	onHelp?: () => void;
	onMessage?: () => void;
	/** Reports the catalogue reason for a refused control on the Message line. */
	onUnavailable?: (reason: string) => void;
	/** The Message fact this panel's own Message line shows. */
	message: MessageFact | null;
	onEmergencyExit: () => void;
	/**
	 * The Queue pause's key on this panel (issue #319, ADR 0111): the brake
	 * reaches every surface the plane draws. Required, because a surface that
	 * resolves the key and swallows it would be a key the plane takes and never
	 * answers.
	 */
	onQueuePause: () => void;
	/**
	 * The Auto-handoff mode's key on this panel (issue #319, ADR 0111): required
	 * for the same reason.
	 */
	onAutoHandoff: () => void;
}

/** The content column stops at 60 cells, the launcher's width. */
const CONTENT_WIDTH = 60;
/** The search holds its value row and its hint row. */
const SEARCH_ROWS = 2;
/** The note row: the range, and the keys the list answers to. */
const NOTE_ROWS = 1;
/** The list window the box wants at its full size. */
const PREFERRED_LIST_ROWS = 12;
/**
 * The list area always holds at least one row: the loading face, the
 * failure line, and the empty word all stand in it, so the box never asks
 * for less room than its own content paints.
 */
const MIN_LIST_ROWS = 1;
/** The badge word a row marked for the queue wears at its end (ADR 0083). */
const QUEUED_BADGE = " queued";

export function RepositorySelectPanel(props: RepositorySelectPanelProps): ReactElement {
	const { width: terminalWidth } = useTerminalDimensions();
	const status = useRepositorySelectFetch(props.fetchRepositories);
	const [query, setQuery] = useState("");
	// The rows the operator marked for the queue (ADR 0083). The mark is the
	// panel's own state: the list keeps no draft, so a close discards it.
	const [pending, setPending] = useState<ReadonlySet<string>>(
		() => new Set(props.initialPending ?? []),
	);
	const list = useRepositorySelectList(status.state === "ready" ? status.repositories : [], query);
	const ink = controlInk();

	// The panel states the facts its own list produces: the rows it holds, the
	// search's text, and the rows the operator marked for the queue.
	const facts = availabilityFacts("repository-select", props.standing, {
		listCanMove: list.filtered.length > 0,
		repositoryCount: list.filtered.length,
		searchText: query,
		pendingCount: pending.size,
	});
	useControlDispatch({
		facts,
		active: props.inputActive,
		onUnavailable: props.onUnavailable,
		onEmergencyExit: props.onEmergencyExit,
		handlers: repositorySelectHandlers(props, {
			region: list.region,
			rows: list.rows,
			repositories: status.state === "ready" ? status.repositories : [],
			pending,
			setPending,
			setQuery,
		}),
	});

	const note = repositorySelectNote(list.region, list.frame);
	const above = repositorySelectAbove({
		status,
		list,
		pending,
		ink,
		query,
		note,
		inputActive: props.inputActive ?? true,
		setQuery,
	});

	return createElement(ModalSurface, {
		frame: list.frame,
		width: terminalWidth,
		title: "Init a repository",
		body: { above, below: [], minRows: SEARCH_ROWS + NOTE_ROWS + MIN_LIST_ROWS },
		message: props.message,
		bar: { mode: "repository-select", facts },
		queuePaused: props.standing.queuePaused,
	});
}

/**
 * The panel's read: the repositories the fetch hands over, or its failure.
 * The read runs once per open: the panel unmounts on close, so a new open is
 * a new read, and the fetch the screen hands in owns the egress.
 */
function useRepositorySelectFetch(
	fetchRepositories: () => Promise<
		| { status: "success"; repositories: readonly InitableRepository[] }
		| { status: "failed"; reason: string }
	>,
): RepositorySelectStatus {
	const [status, setStatus] = useState<RepositorySelectStatus>({ state: "loading" });
	const fetchRef = useRef(fetchRepositories);
	fetchRef.current = fetchRepositories;
	useEffect(() => {
		let open = true;
		void fetchRef.current().then((outcome) => {
			if (!open) return;
			if (outcome.status === "success")
				setStatus({ state: "ready", repositories: outcome.repositories });
			else setStatus({ state: "error", reason: outcome.reason });
		});
		return () => {
			open = false;
		};
	}, []);
	return status;
}

/** The list: the search filter, the frame, the region, the rows. */
function useRepositorySelectList(repositories: readonly InitableRepository[], query: string) {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	// The search filters the list by substring, the way the shared type-ahead
	// matches: containment of the whole query, case-insensitive.
	const filtered =
		query === ""
			? repositories
			: repositories.filter((item) => item.displayName.toLowerCase().includes(query.toLowerCase()));
	const listRows = Math.max(MIN_LIST_ROWS, Math.min(PREFERRED_LIST_ROWS, filtered.length));
	const frame = modalFrame(terminalWidth, terminalHeight, {
		maxWidth: CONTENT_WIDTH + 4,
		rows: SEARCH_ROWS + NOTE_ROWS + listRows,
		// The search, the note, and the one row the state stands on are the
		// part that stays: the list scrolls.
		minRows: SEARCH_ROWS + NOTE_ROWS + MIN_LIST_ROWS,
	});
	const visibleRows = Math.max(0, frame.contentRows - SEARCH_ROWS - NOTE_ROWS);
	const rows: readonly ActionRow[] = filtered.map((item) => ({
		key: item.identity,
		label: item.displayName,
	}));
	const region = useDecisionRegion(rows, visibleRows);
	return { filtered, frame, visibleRows, rows, region };
}

/** The select panel's control catalogue handlers. */
function repositorySelectHandlers(
	props: RepositorySelectPanelProps,
	fields: {
		region: ReturnType<typeof useDecisionRegion>;
		rows: readonly ActionRow[];
		repositories: readonly InitableRepository[];
		pending: ReadonlySet<string>;
		setPending: (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
		setQuery: (query: string) => void;
	},
): Record<string, ControlHandler> {
	const { region, rows, repositories, pending, setPending, setQuery } = fields;
	return {
		help: () => props.onHelp?.(),
		message: () => props.onMessage?.(),
		"move-list": ({ key }) => {
			// The keys the ticket lists run: a step per row, a page per
			// window, and the edge to the end, with the region's own window
			// sliding to keep the row visible.
			const name = key.name;
			if (name === "pageup") region.pageMove(-1);
			else if (name === "pagedown") region.pageMove(1);
			else if (name === "home") region.moveEdge("start");
			else if (name === "end") region.moveEdge("end");
			else region.move(name === "up" || name === "k" ? -1 : 1);
			key.preventDefault?.();
		},
		"select-repository": ({ key }) => {
			key.preventDefault?.();
			region.confirm(() => {
				// The queue the marking holds, in list order. A marking of two
				// or more runs the queue; anything else is the select of the
				// row under the cursor (ADR 0083).
				const marked = rows
					.filter((row) => pending.has(row.key))
					.map((row) => repositories.find((item) => item.identity === row.key))
					.filter((item): item is InitableRepository => item !== undefined);
				const queue =
					marked.length >= 2
						? marked
						: [repositories.find((item) => item.identity === rows[region.at]?.key)].filter(
								(item): item is InitableRepository => item !== undefined,
							);
				if (queue.length > 0) props.onSelect(queue);
			});
		},
		"repository-select-toggle": ({ key }) => {
			key.preventDefault?.();
			const row = rows[region.at];
			if (row === undefined) return;
			setPending((prev) => {
				const next = new Set(prev);
				if (next.has(row.key)) next.delete(row.key);
				else next.add(row.key);
				return next;
			});
		},
		"repository-select-clear": ({ key }) => {
			key.preventDefault?.();
			setQuery("");
		},
		"repository-select-cancel": ({ key }) => {
			key.preventDefault?.();
			props.onCancel();
		},
		// The plane-level keys reach this panel too (issue #319, ADR 0111):
		// the brake and the mode flip on the select, the way they do on
		// every surface the chrome owns.
		"queue-pause": props.onQueuePause,
		"auto-handoff": props.onAutoHandoff,
	};
}

/** The box's above rows: the search, the list, the note. */
function repositorySelectAbove(fields: {
	status: RepositorySelectStatus;
	list: ReturnType<typeof useRepositorySelectList>;
	pending: ReadonlySet<string>;
	ink: ReturnType<typeof controlInk>;
	query: string;
	note: string;
	inputActive: boolean;
	setQuery: (query: string) => void;
}): ReactElement[] {
	const { status, list, pending, ink, query, note, inputActive, setQuery } = fields;
	const bodyRows = repositorySelectBodyRows({ status, list, pending, ink, query });
	return [
		createElement(TextField, {
			label: "Search",
			value: query,
			focused: true,
			inputActive,
			width: list.frame.contentWidth,
			marked: false,
			ink,
			hint: "Type to filter the list.",
			onValueChange: (facts) => setQuery(facts.value),
		}),
		...bodyRows,
		createElement(
			"text",
			{ style: { width: "100%", height: 1 }, fg: ink.detail.fg ?? undefined },
			note,
		),
	];
}

/** The note row: the range, and the keys the list answers to. */
function repositorySelectNote(
	region: ReturnType<typeof useDecisionRegion>,
	frame: ReturnType<typeof modalFrame>,
): string {
	const rangePart = region.rangeText !== undefined ? `${region.rangeText}  ` : "";
	return padToWidth(
		truncateToWidth(
			`${rangePart}Tab toggles the queue. Enter selects. Esc closes.`,
			frame.contentWidth,
		),
		frame.contentWidth,
	);
}

/** The list's body rows: the state the read stands on, or the window's rows. */
function repositorySelectBodyRows(fields: {
	status: RepositorySelectStatus;
	list: ReturnType<typeof useRepositorySelectList>;
	pending: ReadonlySet<string>;
	ink: ReturnType<typeof controlInk>;
	query: string;
}): ReactElement[] {
	const { status, list, pending, ink, query } = fields;
	const { frame } = list;
	const listContentWidth = frame.contentWidth - MARKER_WIDTH;
	const bodyRows: ReactElement[] = [];
	if (status.state === "loading") {
		bodyRows.push(
			createElement(Spinner, { word: "Reading repositories", width: listContentWidth, ink }),
		);
	} else if (status.state === "error") {
		bodyRows.push(
			createElement(
				"text",
				{ fg: ink.error.fg ?? undefined },
				truncateToWidth(status.reason, frame.contentWidth),
			),
		);
	} else if (list.rows.length === 0) {
		bodyRows.push(
			createElement(
				"text",
				{ fg: ink.detail.fg ?? undefined },
				query === "" ? "The list holds no repository." : "No repository holds that search.",
			),
		);
	} else {
		bodyRows.push(
			...repositorySelectListRows({ region: list.region, rows: list.rows, pending, frame, ink }),
		);
	}
	return bodyRows;
}

/** The rows the window holds: the cursor, the list order, the queue's badge. */
function repositorySelectListRows(fields: {
	region: ReturnType<typeof useDecisionRegion>;
	rows: readonly ActionRow[];
	pending: ReadonlySet<string>;
	frame: ReturnType<typeof modalFrame>;
	ink: ReturnType<typeof controlInk>;
}): ReactElement[] {
	const { region, rows, pending, frame, ink } = fields;
	// The row is the repository's display name, whole: the Action item's
	// 20-cell label column would cut an owner/name the operator is choosing.
	// A marked row wears the queue's badge word at its end, the way the
	// list's state badges stand (ADR 0083).
	const selectedKey = rows[region.at]?.key;
	const listRows: ReactElement[] = [];
	for (const row of region.window) {
		const isCursor = row.key === selectedKey;
		const isPending = pending.has(row.key);
		const name = truncateToWidth(
			`${isCursor ? "❯ " : "  "}${row.label}`,
			frame.contentWidth - (isPending ? QUEUED_BADGE.length : 0),
		);
		listRows.push(
			createElement(
				"box",
				{ key: row.key, style: { width: "100%", height: 1, flexDirection: "row" } },
				createElement(
					"text",
					{
						fg: isCursor ? (ink.focusedText.fg ?? undefined) : (ink.text.fg ?? undefined),
					},
					padToWidth(name, frame.contentWidth - (isPending ? QUEUED_BADGE.length : 0)),
				),
				isPending ? createElement("text", { fg: ink.detail.fg ?? undefined }, QUEUED_BADGE) : null,
			),
		);
	}
	return listRows;
}
