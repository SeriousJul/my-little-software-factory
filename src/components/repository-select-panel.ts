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
 * Every control comes from the shared library: the search is the shared Text
 * field, the list is the shared region with its wrap and auto-scroll, and the
 * box is the shared modal chrome. The keys dispatch through the catalogue in
 * the repository-select mode: typing edits the search, up and down and j and
 * k move the cursor, Enter selects the row under the cursor, Del clears the
 * search, Esc closes, and the catalogue names them on the Action bar.
 */
import { createElement, useTerminalDimensions } from "@opentui/react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import type { InitableRepository } from "../repository-list.ts";
import { useControlDispatch } from "./control-dispatch.ts";
import { type ControlContext, contextFor } from "./controls.ts";
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
	onSelect: (repository: InitableRepository) => void;
	onCancel: () => void;
	/** The base control facts, preserved while this panel owns input. */
	context: ControlContext;
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
}

/** The content column stops at 60 cells, the launcher's width. */
const CONTENT_WIDTH = 60;
/** The search holds its value row and its hint row. */
const SEARCH_ROWS = 2;
/** The note row: the range, and the keys the list answers to. */
const NOTE_ROWS = 1;
/** The list window the box wants at its full size. */
const PREFERRED_LIST_ROWS = 12;

export function RepositorySelectPanel({
	fetchRepositories,
	onSelect,
	onCancel,
	context,
	inputActive = true,
	onHelp,
	onMessage,
	onUnavailable,
	message,
	onEmergencyExit,
}: RepositorySelectPanelProps): ReactElement {
	const { width: terminalWidth, height: terminalHeight } = useTerminalDimensions();
	const [status, setStatus] = useState<RepositorySelectStatus>({ state: "loading" });
	const [query, setQuery] = useState("");
	// The read runs once per open: the panel unmounts on close, so a new
	// open is a new read, and the fetch the screen hands in owns the egress.
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

	const repositories = status.state === "ready" ? status.repositories : [];
	// The search filters the list by substring, the way the shared type-ahead
	// matches: containment of the whole query, case-insensitive.
	const filtered =
		query === ""
			? repositories
			: repositories.filter((item) => item.displayName.toLowerCase().includes(query.toLowerCase()));

	const frame = modalFrame(terminalWidth, terminalHeight, {
		maxWidth: CONTENT_WIDTH + 4,
		rows: SEARCH_ROWS + NOTE_ROWS + Math.min(PREFERRED_LIST_ROWS, filtered.length),
		// The search and the note are the part that stays: the list scrolls.
		minRows: SEARCH_ROWS + NOTE_ROWS,
	});
	const visibleRows = Math.max(0, frame.contentRows - SEARCH_ROWS - NOTE_ROWS);
	const rows: readonly ActionRow[] = filtered.map((item) => ({
		key: item.identity,
		label: item.displayName,
	}));
	const region = useDecisionRegion(rows, visibleRows);
	const ink = controlInk();

	useControlDispatch({
		mode: "repository-select",
		context: contextFor("repository-select", {
			...context,
			listCanMove: filtered.length > 0,
			repositoryCount: filtered.length,
			searchText: query,
		}),
		active: inputActive,
		onUnavailable,
		onEmergencyExit,
		handlers: {
			help: () => onHelp?.(),
			message: () => onMessage?.(),
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
				region.confirm((row) => {
					const chosen = repositories.find((item) => item.identity === row.key);
					if (chosen !== undefined) onSelect(chosen);
				});
			},
			"repository-select-clear": ({ key }) => {
				key.preventDefault?.();
				setQuery("");
			},
			"repository-select-cancel": ({ key }) => {
				key.preventDefault?.();
				onCancel();
			},
		},
	});

	// The list area: the window's rows, or the one row the state stands on.
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
	} else if (rows.length === 0) {
		bodyRows.push(
			createElement(
				"text",
				{ fg: ink.detail.fg ?? undefined },
				query === "" ? "The list holds no repository." : "No repository holds that search.",
			),
		);
	} else {
		// The row is the repository's display name, whole: the Action item's
		// 20-cell label column would cut an owner/name the operator is choosing.
		const selectedKey = rows[region.at]?.key;
		for (const row of region.window)
			bodyRows.push(
				createElement(
					"text",
					{
						key: row.key,
						style: { width: "100%", height: 1 },
						fg:
							row.key === selectedKey
								? (ink.focusedText.fg ?? undefined)
								: (ink.text.fg ?? undefined),
					},
					padToWidth(
						truncateToWidth(
							`${row.key === selectedKey ? "❯ " : "  "}${row.label}`,
							frame.contentWidth,
						),
						frame.contentWidth,
					),
				),
			);
	}

	const rangePart = region.rangeText !== undefined ? `${region.rangeText}  ` : "";
	const note = padToWidth(
		truncateToWidth(`${rangePart}Enter selects. Esc closes.`, frame.contentWidth),
		frame.contentWidth,
	);

	return createElement(ModalSurface, {
		frame,
		width: terminalWidth,
		title: "Init a repository",
		body: {
			above: [
				createElement(TextField, {
					label: "Search",
					value: query,
					focused: true,
					inputActive,
					width: frame.contentWidth,
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
			],
			below: [],
			minRows: SEARCH_ROWS + NOTE_ROWS,
		},
		message,
		bar: {
			mode: "repository-select",
			context: contextFor("repository-select", {
				...context,
				listCanMove: filtered.length > 0,
				repositoryCount: filtered.length,
				searchText: query,
			}),
		},
	});
}
