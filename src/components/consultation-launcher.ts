/** The Consultation launcher. It is deliberately a small modal, not a Ticket override. */
import { createElement, useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRef, useState } from "react";

import type { ConsultationTypeConfig } from "../config.ts";
import type { ConsultationRepositoryOption } from "../consultation.ts";
import { isLiteralText, utf8ByteLength, validateConsultationInput } from "../consultation.ts";
import { truncateToWidth, wrapToWidth } from "./text.ts";
import { COLORS } from "./theme.ts";

interface ConsultationLauncherProps {
	types: Readonly<Record<string, ConsultationTypeConfig>>;
	repositories: readonly ConsultationRepositoryOption[];
	initialRepository?: string;
	initialType?: string;
	initialInput?: string;
	title?: string;
	onLaunch: (typeName: string, repository: ConsultationRepositoryOption, input: string) => void;
	onCancel: () => void;
}

export function ConsultationLauncher({
	types,
	repositories,
	initialRepository,
	initialType,
	initialInput = "",
	title = "Consultation launcher",
	onLaunch,
	onCancel,
}: ConsultationLauncherProps) {
	const { width, height } = useTerminalDimensions();
	const names = Object.keys(types);
	const initialTypeIndex = Math.max(0, names.indexOf(initialType ?? ""));
	const [typeIndex, setTypeIndex] = useState(initialTypeIndex);
	const [repositoryIndex, setRepositoryIndex] = useState(() => {
		const index = repositories.findIndex((repository) => repository.identity === initialRepository);
		return index < 0 ? 0 : index;
	});
	const [input, setInput] = useState(initialInput);
	const [field, setField] = useState(0);
	const [error, setError] = useState<string | undefined>();
	const inputRef = useRef(input);
	const fieldRef = useRef(0);
	const typeRef = useRef(initialTypeIndex);
	const repositoryRef = useRef(repositoryIndex);
	const setInputValue = (value: string) => {
		inputRef.current = value;
		setInput(value);
		setError(undefined);
	};
	const moveField = (delta: number) => {
		const next = (fieldRef.current + delta + 3) % 3;
		fieldRef.current = next;
		setField(next);
	};
	const cycle = (delta: number) => {
		if (fieldRef.current === 0 && names.length > 0) {
			const next = (typeRef.current + delta + names.length) % names.length;
			typeRef.current = next;
			setTypeIndex(next);
		} else if (fieldRef.current === 1 && repositories.length > 0) {
			const next = (repositoryRef.current + delta + repositories.length) % repositories.length;
			repositoryRef.current = next;
			setRepositoryIndex(next);
		}
	};
	const launch = () => {
		if (names.length === 0) {
			setError(
				"no Consultation types configured; add [consultation-types.<name>] to the config file",
			);
			return;
		}
		if (repositories.length === 0) {
			setError("no verified Repository is available");
			return;
		}
		const validation = validateConsultationInput(inputRef.current);
		if (validation !== undefined) {
			setError(validation);
			return;
		}
		onLaunch(names[typeRef.current], repositories[repositoryRef.current], inputRef.current);
	};
	useKeyboard((key) => {
		if (key.ctrl || key.meta) return;
		if (key.name === "escape") {
			onCancel();
			return;
		}
		if (key.name === "tab") {
			moveField(key.shift ? -1 : 1);
			return;
		}
		if (key.name === "return") {
			if (key.shift) {
				if (fieldRef.current === 2) setInputValue(`${inputRef.current}\n`);
				return;
			}
			launch();
			return;
		}
		if (key.name === "up") {
			moveField(-1);
			return;
		}
		if (key.name === "down") {
			moveField(1);
			return;
		}
		if (key.name === "left") {
			cycle(-1);
			return;
		}
		if (key.name === "right") {
			cycle(1);
			return;
		}
		if (key.name === "backspace" && fieldRef.current === 2) {
			setInputValue(inputRef.current.slice(0, -1));
			return;
		}
		if (fieldRef.current === 2 && [...key.name].length > 0 && isLiteralText(key.name))
			setInputValue(inputRef.current + key.name);
	});
	const innerWidth = Math.max(1, width - 6);
	const currentType = names[typeIndex];
	const currentRepository = repositories[repositoryIndex];
	const inputLines =
		input === "" ? ["(empty)"] : input.split("\n").flatMap((line) => wrapToWidth(line, innerWidth));
	const visibleInput = inputLines.slice(0, Math.max(1, height - 10));
	const rows = [
		`${field === 0 ? "❯ " : "  "}Type         ${currentType ?? "(none)"}`,
		`${field === 1 ? "❯ " : "  "}Repository   ${currentRepository?.displayName ?? "(none)"}`,
		`${field === 2 ? "❯ " : "  "}Initial input`,
		...visibleInput.map((line) => `   ${line}`),
		`UTF-8 bytes: ${utf8ByteLength(input)}/65536`,
		...(error === undefined ? [] : [`Error: ${error}`]),
	];
	return createElement(
		"box",
		{
			style: {
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				zIndex: 20,
				backgroundColor: COLORS.overlay,
				alignItems: "center",
				justifyContent: "center",
			},
		},
		createElement(
			"box",
			{
				border: true,
				borderColor: COLORS.borderFocused,
				title,
				padding: 1,
				style: { flexDirection: "column", maxWidth: Math.max(1, width - 2) },
			},
			...rows.map((row, index) =>
				createElement(
					"text",
					{
						key: index,
						fg: row.startsWith("Error:")
							? COLORS.statusError
							: index === rows.length - 1 && error === undefined
								? COLORS.dim
								: COLORS.text,
					},
					truncateToWidth(row, innerWidth),
				),
			),
			createElement(
				"text",
				{ fg: COLORS.dim },
				truncateToWidth(
					"tab fields  arrows choose  enter launch  shift+enter newline  esc cancel",
					innerWidth,
				),
			),
		),
	);
}
