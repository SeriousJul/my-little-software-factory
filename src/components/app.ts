/**
 * The app shell: the split panes, the key handling, and the state the
 * control plane holds.
 *
 * The panes and their key handling stay in their components. The shell
 * keeps the shared state (the selected ticket and the focused pane), wires
 * the key bindings, and renders the status line the handoffs fill.
 *
 * The shell also owns the handoff: Enter on an open ticket hands it off
 * with the config defaults. The e key opens the override panel for a
 * one-shot change. One handoff runs at a time: while one is in flight the
 * keys of the app keep working and a second handoff is refused with a hint.
 */
import os from "node:os";
import { createElement, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useState } from "react";

import { DEFAULT_CONFIG, defaultConfigPath, type FactoryConfig, persistConfig } from "../config.ts";
import { SAMPLE_TICKETS } from "../data/sample-tickets.ts";
import { type EnvironmentKind, HANDOFF_ENVIRONMENT_KINDS } from "../domain/ticket.ts";
import { type HandoffChoice, handOffTicket } from "../handoff.ts";
import { type CommandRunner, createChildProcessRunner } from "../runner.ts";
import { maxScrollOf, usePaneGeometry } from "./geometry.ts";
import { type AgentSettings, type OverrideChoice, OverridePanel } from "./override-panel.ts";
import { truncateToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";
import { detailLines, TicketDetail } from "./ticket-detail.ts";
import { TicketList } from "./ticket-list.ts";

type Pane = "list" | "detail";

/** One line under the panes: the outcome of the last handoff, if any. */
interface StatusMessage {
	kind: "info" | "warning" | "error";
	text: string;
}

export type AppKey = "j" | "k" | "h" | "l" | "q" | "e" | "up" | "down" | "left" | "right";

export interface AppProps {
	/** The validated config; the test doubles inject theirs. */
	config?: FactoryConfig;
	/** The command egress; the test doubles inject a fake runner. */
	runner?: CommandRunner;
	/** The home directory the ~/src convention resolves under. */
	home?: string;
	/** The config file the repository mappings write back to. */
	configPath?: string;
}

const realRunner = createChildProcessRunner();

export function App({ config: configProp, runner, home, configPath }: AppProps) {
	const renderer = useRenderer();
	const { width: terminalWidth } = useTerminalDimensions();
	const [config, setConfig] = useState<FactoryConfig>(() => configProp ?? DEFAULT_CONFIG);
	const [tickets, setTickets] = useState(() => SAMPLE_TICKETS.map((t) => ({ ...t })));
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [focusedPane, setFocusedPane] = useState<Pane>("list");
	const [detailScroll, setDetailScroll] = useState(0);
	const [status, setStatus] = useState<StatusMessage | null>(null);
	const [inFlight, setInFlight] = useState(false);
	const [override, setOverride] = useState<OverrideChoice | null>(null);

	const commandRunner: CommandRunner = runner ?? realRunner;
	const homeDir = home ?? os.homedir();
	const configFile = configPath ?? defaultConfigPath();

	// The status line reserves one terminal row when it carries a message;
	// the panes render one row shorter so the window math stays true.
	const reservedRows = status !== null ? 1 : 0;
	const detailGeometry = usePaneGeometry("detail", reservedRows);
	const lines = detailLines(tickets[selectedIndex], detailGeometry.usableCols);
	const maxScroll = maxScrollOf(lines.length, detailGeometry.visibleRows);
	const scroll = Math.min(detailScroll, maxScroll);

	const agentSettings: Record<string, AgentSettings> = Object.fromEntries(
		Object.entries(config.agents).map(([name, agent]) => [
			name,
			{
				model: agent.model !== undefined,
				thinking: agent.thinking !== undefined,
				thinkingValues: agent.thinkingValues,
			},
		]),
	);

	const defaultChoice: HandoffChoice = {
		agentType: config.defaultAgent,
		environment: config.defaultEnvironment,
		taskType: config.defaultTaskType,
		model: "",
		thinking: "",
	};

	const startHandoff = (choice: HandoffChoice) => {
		if (inFlight) {
			return;
		}
		const index = selectedIndex;
		const ticket = tickets[index];
		if (ticket.state !== "open") {
			setStatus({ kind: "warning", text: "only open tickets can be handed off" });
			return;
		}
		setInFlight(true);
		setStatus({ kind: "info", text: `handing off "${ticket.title}"...` });
		void handOffTicket(ticket, choice, {
			config,
			runner: commandRunner,
			home: homeDir,
		}).then((outcome) => {
			if (outcome.started) {
				const handoff = {
					agentType: choice.agentType,
					environment: choice.environment,
					taskType: choice.taskType,
				};
				setTickets((all) =>
					all.map((t, i) => (i === index ? { ...t, state: "handed-off", handoff } : t)),
				);
			}
			if (outcome.mappingToWrite !== undefined) {
				persistMapping(outcome.mappingToWrite);
			}
			if (!outcome.ok) {
				setStatus({ kind: "error", text: outcome.reason ?? "handoff failed" });
			} else if (outcome.warning !== undefined) {
				setStatus({ kind: "warning", text: outcome.warning });
			} else {
				setStatus(null);
			}
			setInFlight(false);
		});
	};

	/** Fold a sibling-clone mapping into the config file on disk. */
	const persistMapping = (mapping: { repository: string; path: string }) => {
		try {
			const updated = { ...config, repos: { ...config.repos, [mapping.repository]: mapping.path } };
			setConfig(updated);
			persistConfig(configFile, updated);
		} catch {
			// The in-memory config keeps the mapping for this session; the
			// next start re-resolves from disk and writes it back again.
		}
	};

	const openOverride = () => {
		if (inFlight) {
			return;
		}
		const ticket = tickets[selectedIndex];
		if (ticket.state !== "open") {
			setStatus({ kind: "warning", text: "only open tickets can be handed off" });
			return;
		}
		setOverride({ ...defaultChoice });
	};

	useKeyboard((key) => {
		// While the panel is open it owns the keys; the app below is inert.
		if (override !== null) {
			return;
		}
		switch (key.name) {
			case "q":
				renderer.destroy();
				break;
			case "h":
			case "left":
				setFocusedPane("list");
				break;
			case "l":
			case "right":
				setFocusedPane("detail");
				break;
			case "j":
			case "down":
				moveVertical(1);
				break;
			case "k":
			case "up":
				moveVertical(-1);
				break;
			case "return":
				// The keys keep working while a handoff is in flight; a
				// second handoff is refused until the first settles.
				startHandoff(defaultChoice);
				break;
			case "e":
				openOverride();
				break;
			default:
				break;
		}
	});

	// The vertical keys act on the focused pane. With the detail focused,
	// they scroll its content and leave the selection where it is.
	function moveVertical(delta: number) {
		if (focusedPane === "detail") {
			setDetailScroll((current) => clamp(current + delta, 0, maxScroll));
		} else {
			setSelectedIndex((i) => clamp(i + delta, 0, tickets.length - 1));
			// A new ticket starts at the top of its detail.
			setDetailScroll(0);
		}
	}

	const statusColor =
		status?.kind === "error"
			? COLORS.statusError
			: status?.kind === "warning"
				? COLORS.statusWarning
				: COLORS.text;

	return createElement(
		"box",
		{ style: { width: "100%", height: "100%", flexDirection: "column" } },
		createElement(
			"box",
			{ style: { width: "100%", flexGrow: 1, flexDirection: "row" } },
			createElement(TicketList, {
				tickets,
				selectedIndex,
				focused: focusedPane === "list",
				reservedRows,
			}),
			createElement(TicketDetail, {
				lines,
				visibleRows: detailGeometry.visibleRows,
				scroll,
				focused: focusedPane === "detail",
			}),
		),
		status !== null &&
			createElement(
				"text",
				{ style: { width: "100%", fg: statusColor } },
				truncateToWidth(status.text, terminalWidth),
			),
		override !== null &&
			createElement(OverridePanel, {
				agents: Object.keys(config.agents),
				environments: HANDOFF_ENVIRONMENT_KINDS,
				taskTypes: Object.keys(config.taskTypes),
				agentSettings,
				initial: override,
				onConfirm: (choice) => {
					setOverride(null);
					// The environments list is HANDOFF_ENVIRONMENT_KINDS, so the
					// value the panel returns is always a handoff kind.
					startHandoff({
						...choice,
						environment: choice.environment as EnvironmentKind,
					});
				},
				onCancel: () => {
					setOverride(null);
				},
			}),
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
