/**
 * The plane's out-of-band attention (ADR 0080): the one service that owns
 * both channels that leave the terminal.
 *
 * One operation sends the desktop notification for a standing warning or
 * error fact of the Message line, carrying the severity and the full,
 * untruncated text. One operation rings the terminal bell, the held-count
 * bell and the Consultation attention bell alike. No surface holds its own
 * copy of either: the Message line's shared fact hook takes this service,
 * and the app's bell sites call its ring.
 *
 * Every send runs through the Command runner, the plane's single egress:
 * one fire-and-forget command on the platform's own notification path,
 * `notify-send` on Linux, the built-in `osascript` on macOS, and the static
 * PowerShell balloon tip on Windows. The platform choice is a constructor
 * parameter defaulting to the runtime's platform, so the suite exercises
 * every sender branch on any machine. A send that fails - no tool, a
 * nonzero exit, a spawn error - leaves a developer log line and changes
 * nothing the operator sees on the plane.
 */
import type { FactoryConfig } from "./config.ts";
import { type Logger, NOOP_LOGGER } from "./logging.ts";
import { type CommandRunner, commandFailureText, errorMessage } from "./runner.ts";

/** The severities a desktop notification carries. */
export type AttentionSeverity = "warning" | "error";

/** The fact a desktop notification carries: the severity and the full text. */
export interface AttentionFact {
	severity: AttentionSeverity;
	text: string;
}

/**
 * The app name the notification names its sender with, where the platform's
 * mechanism has a name for it: the plane's package name.
 */
export const DESKTOP_NOTIFICATION_APP_NAME = "my-little-software-factory";

/** The fixed title form of one severity's notification. */
export function notificationTitle(fact: AttentionFact): string {
	return `Factory: ${fact.severity}`;
}

/** The WScript.Shell.Popup icon: 1 the critical hand, 2 the warning mark. */
const POWERSHELL_ICON: Record<AttentionSeverity, number> = { error: 1, warning: 2 };

/**
 * The WScript.Shell.Popup timeout in seconds: 0 the sticky window that
 * stands until the operator closes it, the few seconds a warning holds
 * before it clears on its own.
 */
const POWERSHELL_TIMEOUT: Record<AttentionSeverity, number> = { error: 0, warning: 5 };

export interface AttentionServiceOptions {
	/** The platform the senders run on. Default: the runtime's platform. */
	platform?: string;
	/** The record a failed send leaves a line in. Default: no record. */
	logger?: Logger;
}

export class AttentionService {
	private readonly config: () => FactoryConfig;
	private readonly runner: CommandRunner;
	private readonly platform: string;
	private readonly logger: Logger;
	/** The last fact the service notified, or none before the first send. */
	private lastNotified: AttentionFact | null = null;

	constructor(
		/**
		 * The config read at the write, not at the construction: the bell's
		 * gate and the notification's gate read the config they run under.
		 */
		config: () => FactoryConfig,
		runner: CommandRunner,
		options: AttentionServiceOptions = {},
	) {
		this.config = config;
		this.runner = runner;
		this.platform = options.platform ?? process.platform;
		this.logger = options.logger ?? NOOP_LOGGER;
	}

	/**
	 * Ring the terminal bell.
	 *
	 * The gate is `attention-bell`, read at the ring so a config the app
	 * holds current switches the bell without a rebuild of the service. The
	 * caller owns the flash it wants beside the ring; only the write and
	 * the gate live here.
	 */
	ring(): void {
		if (!this.config().attentionBell) return;
		process.stdout.write("\u0007");
	}

	/**
	 * Send the desktop notification for one warning or error fact that the
	 * Message line stands.
	 *
	 * The standing-fact rule (ADR 0080): while the identical fact - the same
	 * severity and the same text - stands, the service sends none. Any
	 * different fact that stands resets the memory, so the fact notifies
	 * again when it stands again. The memory is per run and in memory, like
	 * the plane's other per-run attention state. The send is
	 * fire-and-forget inside the runner's own budget, and a failed send
	 * degrades to a developer log line.
	 */
	notify(fact: AttentionFact): void {
		if (!this.config().desktopNotification) return;
		const last = this.lastNotified;
		if (last !== null && last.severity === fact.severity && last.text === fact.text) return;
		this.lastNotified = fact;
		void this.send(fact);
	}

	/** The one command the fact sends on this platform, argv split, no shell. */
	private commandFor(fact: AttentionFact): [string, string[]] {
		const title = notificationTitle(fact);
		switch (this.platform) {
			case "darwin": {
				// The built-in notification, nothing to install: the title
				// form and the full text as the body, the text as one argv
				// element the script holds.
				const script = `display notification "${appleScriptString(fact.text)}" with title "${title}"`;
				return ["osascript", ["-e", script]];
			}
			case "win32": {
				// The static balloon tip: the full text, the title, the
				// severity's icon, and the timeout the severity earns - the
				// error stands until closed, the warning clears on its own -
				// the text as one argv element.
				const script =
					`$w = New-Object -ComObject WScript.Shell; ` +
					`[void]$w.Popup('${powershellString(fact.text)}', ${POWERSHELL_TIMEOUT[fact.severity]}, '${title}', ${POWERSHELL_ICON[fact.severity]})`;
				return [
					"powershell",
					["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
				];
			}
			default: {
				// The desktop's own notification stack: the app name, the title,
				// the full text, and the urgency the severity earns.
				const urgency = fact.severity === "error" ? "critical" : "normal";
				return [
					"notify-send",
					["--app-name", DESKTOP_NOTIFICATION_APP_NAME, "-u", urgency, title, fact.text],
				];
			}
		}
	}

	private async send(fact: AttentionFact): Promise<void> {
		const [command, args] = this.commandFor(fact);
		try {
			const result = await this.runner.run(command, args);
			if (result.code !== 0) {
				this.logger.warn(`desktop notification not sent: ${commandFailureText(result)}`);
			}
		} catch (error) {
			this.logger.warn(`desktop notification not sent: ${errorMessage(error)}`);
		}
	}
}

/** Double the quotes: the AppleScript string escape. */
function appleScriptString(text: string): string {
	return text.replace(/"/g, '""');
}

/** Double the apostrophes: the PowerShell single-quoted string escape. */
function powershellString(text: string): string {
	return text.replace(/'/g, "''");
}
