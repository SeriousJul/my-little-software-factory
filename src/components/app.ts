/** The control plane shell: panes, refresh, selection, and handoff. */
import os from "node:os";
import { createElement, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { DEFAULT_CONFIG, defaultConfigPath, type FactoryConfig, persistConfig } from "../config.ts";
import { HANDOFF_ENVIRONMENT_KINDS, type Ticket } from "../domain/ticket.ts";
import { type HandoffChoice, handOffTicket } from "../handoff.ts";
import { RefreshCoordinator } from "../refresh.ts";
import type { RepositoryMapping } from "../repo.ts";
import { type CommandRunner, createChildProcessRunner, errorMessage } from "../runner.ts";
import type { FactoryState } from "../state.ts";
import type { TicketSource } from "../ticket-source.ts";
import { maxScrollOf, usePaneGeometry } from "./geometry.ts";
import { type AgentSettings, OverridePanel } from "./override-panel.ts";
import { truncateToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";
import { detailLines, TicketDetail } from "./ticket-detail.ts";
import { TicketList } from "./ticket-list.ts";

type Pane = "list" | "detail";
interface StatusMessage {
	kind: "info" | "warning" | "error";
	text: string;
}
export type AppKey = "j" | "k" | "h" | "l" | "q" | "e" | "r" | "up" | "down" | "left" | "right";

export interface AppProps {
	config?: FactoryConfig;
	runner?: CommandRunner;
	home?: string;
	configPath?: string;
	/** SQLite state. The factory entry module owns its process lease. */
	state?: FactoryState;
	/** Bound sources. Tests inject deterministic sources here. */
	sources?: readonly TicketSource[];
	/** Test-only deterministic ticket projection. It has no production caller. */
	initialTickets?: readonly Ticket[];
}

const EMPTY_SOURCES: readonly TicketSource[] = [];
let lazyRealRunner: CommandRunner | undefined;
function realRunner(): CommandRunner {
	lazyRealRunner ??= createChildProcessRunner();
	return lazyRealRunner;
}

export function App({
	config: configProp,
	runner,
	home,
	configPath,
	state,
	sources = EMPTY_SOURCES,
	initialTickets,
}: AppProps) {
	const renderer = useRenderer();
	const { width: terminalWidth } = useTerminalDimensions();
	const [config, setConfig] = useState<FactoryConfig>(() => configProp ?? DEFAULT_CONFIG);
	// Only test callers supply deterministic tickets. Production starts with
	// the empty SQLite projection while configured sources refresh.
	const [tickets, setTickets] = useState<Ticket[]>(() => [...(initialTickets ?? [])]);
	const ticketsRef = useRef(tickets);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const selectedIndexRef = useRef(0);
	const configRef = useRef(config);
	configRef.current = config;
	const [focusedPane, setFocusedPane] = useState<Pane>("list");
	const [detailScroll, setDetailScroll] = useState(0);
	const [status, setStatus] = useState<StatusMessage | null>(null);
	const [override, setOverride] = useState<HandoffChoice | null>(null);
	const [healths, setHealths] = useState(() => state?.sourceHealths() ?? []);
	const inFlightRef = useRef(false);
	const coordinatorRef = useRef<RefreshCoordinator | undefined>(undefined);

	const commandRunner = runner ?? realRunner();
	const homeDir = home ?? os.homedir();
	const configFile = configPath ?? defaultConfigPath();
	const healthLine = healths
		.filter((health) => health.health === "stale" || health.health === "removed")
		.map(
			(health) =>
				`${health.name}: ${health.health}${health.error === undefined ? "" : ` - ${health.error}`}`,
		)
		.join("; ");
	const reservedRows = (status === null ? 0 : 1) + (healthLine === "" ? 0 : 1);
	const detailGeometry = usePaneGeometry("detail", reservedRows);
	const selectedTicket = tickets[selectedIndex];
	const lines = detailLines(selectedTicket, detailGeometry.usableCols);
	const maxScroll = maxScrollOf(lines.length, detailGeometry.visibleRows);
	const scroll = Math.min(detailScroll, maxScroll);

	const replaceTickets = useCallback(() => {
		if (state === undefined) return;
		const currentConfig = configRef.current;
		const next = state.visibleTickets(currentConfig.taskRules, currentConfig.defaultTaskType);
		const currentIndex = selectedIndexRef.current;
		const selectedId = ticketsRef.current[currentIndex]?.identity;
		const preserved =
			selectedId === undefined ? -1 : next.findIndex((ticket) => ticket.identity === selectedId);
		const nextIndex =
			preserved >= 0 ? preserved : Math.max(0, Math.min(currentIndex, next.length - 1));
		ticketsRef.current = next;
		selectedIndexRef.current = nextIndex;
		setTickets(next);
		setHealths(state.sourceHealths());
		setSelectedIndex(nextIndex);
		if (selectedId === undefined || !next.some((ticket) => ticket.identity === selectedId))
			setDetailScroll(0);
	}, [state]);

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
	// The task types' thinking defaults, keyed by task type name, for the
	// override panel's thinking row.
	const thinkingDefaults: Record<string, string | undefined> = Object.fromEntries(
		Object.entries(config.taskTypes).map(([name, type]) => [name, type.thinking]),
	);
	const choiceFor = (ticket: Ticket): HandoffChoice => ({
		agentType: config.defaultAgent,
		environment: config.defaultEnvironment,
		taskType: ticket.suggestedTaskType,
		model: "",
		// The task type's thinking default: the panel shows it as the
		// starting value of the thinking row, and Enter applies it. The
		// operator picks another level in the panel, or clears a free-text
		// row to leave the level to the agent.
		thinking: config.taskTypes[ticket.suggestedTaskType]?.thinking ?? "",
	});

	const persistMapping = async (mapping: RepositoryMapping): Promise<string | undefined> => {
		try {
			const updated = { ...config, repos: { ...config.repos, [mapping.repository]: mapping.path } };
			setConfig(updated);
			await persistConfig(configFile, updated);
			return undefined;
		} catch (error) {
			return `could not persist the repository mapping: ${errorMessage(error)}`;
		}
	};

	const startHandoff = (choice: HandoffChoice) => {
		if (inFlightRef.current) {
			setStatus({ kind: "warning", text: "handoff in flight" });
			return;
		}
		const ticket = ticketsRef.current[selectedIndexRef.current];
		if (ticket === undefined) {
			setStatus({ kind: "warning", text: "no ticket is selected" });
			return;
		}
		if (ticket.state !== "open") {
			setStatus({ kind: "warning", text: "only open tickets can be handed off" });
			return;
		}
		if (ticket.actionable === false) {
			setStatus({
				kind: "warning",
				text: ticket.handoffRecoveryRequired
					? "handoff recovery is required before another handoff"
					: "ticket is not actionable because its sources are stale, removed, or absent",
			});
			return;
		}
		const claim = state?.claimHandoff(ticket.identity, choice);
		if (claim !== undefined && !claim.ok) {
			setStatus({ kind: "warning", text: claim.reason });
			return;
		}
		inFlightRef.current = true;
		setStatus({ kind: "info", text: `handing off "${ticket.title}"...` });
		void handOffTicket(ticket, choice, {
			config,
			runner: commandRunner,
			home: homeDir,
			onStage: (stage) => {
				if (state && claim?.ok) state.advanceHandoffAttempt(claim.claim.attemptId, stage);
			},
		})
			.then(async (outcome) => {
				if (state && claim?.ok) {
					state.settleHandoff(
						claim.claim.attemptId,
						outcome.status !== "failed",
						outcome.status === "ok" ? undefined : outcome.reason,
					);
					replaceTickets();
				} else if (outcome.status !== "failed") {
					const handoff = {
						agentType: choice.agentType,
						environment: choice.environment,
						taskType: choice.taskType,
					};
					setTickets((all) => {
						const next = all.map((candidate, index) =>
							index === selectedIndexRef.current
								? { ...candidate, state: "handed-off" as const, handoff }
								: candidate,
						);
						ticketsRef.current = next;
						return next;
					});
				}
				const persistWarning =
					outcome.notes?.mappingToWrite === undefined
						? undefined
						: await persistMapping(outcome.notes.mappingToWrite);
				if (outcome.status !== "ok")
					setStatus({
						kind: "error",
						text:
							persistWarning === undefined
								? outcome.reason
								: `${outcome.reason}; ${persistWarning}`,
					});
				else if (persistWarning !== undefined) setStatus({ kind: "warning", text: persistWarning });
				else if (outcome.notes?.warning !== undefined)
					setStatus({ kind: "warning", text: outcome.notes.warning });
				else setStatus(null);
				inFlightRef.current = false;
			})
			.catch((error) => {
				if (state && claim?.ok) {
					state.settleHandoff(claim.claim.attemptId, false, errorMessage(error));
					replaceTickets();
				}
				setStatus({ kind: "error", text: `handoff failed: ${errorMessage(error)}` });
				inFlightRef.current = false;
			});
	};

	const openOverride = () => {
		if (inFlightRef.current) {
			setStatus({ kind: "warning", text: "handoff in flight" });
			return;
		}
		const ticket = ticketsRef.current[selectedIndexRef.current];
		if (ticket === undefined || ticket.state !== "open") {
			setStatus({ kind: "warning", text: "only open tickets can be handed off" });
			return;
		}
		if (ticket.actionable === false) {
			setStatus({
				kind: "warning",
				text: ticket.handoffRecoveryRequired
					? "handoff recovery is required before another handoff"
					: "ticket is not actionable because its sources are stale, removed, or absent",
			});
			return;
		}
		setOverride(choiceFor(ticket));
	};

	useKeyboard((key) => {
		if (override !== null) return;
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
				if (ticketsRef.current[selectedIndexRef.current] !== undefined)
					startHandoff(choiceFor(ticketsRef.current[selectedIndexRef.current]));
				break;
			case "e":
				openOverride();
				break;
			case "r":
				coordinatorRef.current?.refreshAll();
				break;
			default:
				break;
		}
	});

	// A ref lets the key handler use the startup coordinator without making
	// React recreate keyboard subscriptions on each frame.
	useEffect(() => {
		if (state === undefined) return;
		const coordinator = new RefreshCoordinator(sources, state, replaceTickets);
		coordinatorRef.current = coordinator;
		coordinator.start();
		return () => {
			coordinator.stop();
			coordinatorRef.current = undefined;
		};
	}, [state, sources, replaceTickets]);

	function moveVertical(delta: number) {
		if (focusedPane === "detail")
			setDetailScroll((current) => clamp(current + delta, 0, maxScroll));
		else {
			setSelectedIndex((index) => {
				const next = clamp(index + delta, 0, ticketsRef.current.length - 1);
				selectedIndexRef.current = next;
				return next;
			});
			setDetailScroll(0);
		}
	}

	const emptyMessage =
		state === undefined
			? undefined
			: config.sources.length === 0
				? "no ticket sources configured"
				: healths.length === 0 || healths.some((health) => health.health === "loading")
					? "loading tickets..."
					: "no tickets match the configured sources";
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
				emptyMessage,
			}),
			createElement(TicketDetail, {
				lines,
				visibleRows: detailGeometry.visibleRows,
				scroll,
				focused: focusedPane === "detail",
			}),
		),
		healthLine !== "" &&
			createElement(
				"text",
				{ style: { width: "100%", fg: COLORS.statusWarning } },
				truncateToWidth(healthLine, terminalWidth),
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
				thinkingDefaults,
				initial: override,
				onConfirm: (choice) => {
					setOverride(null);
					startHandoff(choice);
				},
				onCancel: () => setOverride(null),
			}),
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}
